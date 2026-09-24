/**
 * What has been spent on AI, read straight from `ai_calls`.
 *
 * `ai_calls` is the only record of spend: every call writes one row with its real cost, so a
 * budget is a sum over a window rather than a running total that something has to keep correct.
 * Resetting a counter moves that account's window (a reset marker in its settings); nothing is
 * deleted, so the call log stays complete. Reading spend never touches `ai_reservations`: a hold
 * is capacity for a call in flight, taken and released by the worker, and deliberately not mixed
 * into what was spent. The writes here are `recordAiCall`, which appends the row a finished call
 * leaves behind, and `releaseAiHolds`, which drops holds whose call can no longer be in flight.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./client";
import { aiCalls } from "./schema";

/**
 * One account's recorded spend since `since`, in USD: what its own monthly budget counts. Work
 * that belongs to no account carries no `user_id` and is excluded.
 */
export async function accountAiSpend(db: Db, userId: string, since: Date): Promise<number> {
  const rows = await db.execute<{ total: number }>(
    sql`select coalesce(sum(cost_usd::float8), 0) as total from ai_calls where user_id = ${userId} and at >= ${since}`,
  );
  return Number(rows.rows[0]?.total ?? 0);
}

/** Every call since `since`, whoever it was for: the deployment's report, not a budget. */
export async function totalAiSpend(db: Db, since: Date): Promise<number> {
  const rows = await db.execute<{ total: number }>(
    sql`select coalesce(sum(cost_usd::float8), 0) as total from ai_calls where at >= ${since}`,
  );
  return Number(rows.rows[0]?.total ?? 0);
}

/* ---------------------------------------------------------------------------------------------
 * The outcome taxonomy
 *
 * `ai_calls` carries one boolean, and not everything it marks false is a model that let us down.
 * A batch cancelled because a sibling failed, a call stopped because its task ran out of time or
 * lost its lease, and a stream cut off at the stall ceiling, are the engine stopping work — the
 * first two are a cost the deployment chose to stop paying, the last is a vendor symptom. Counting
 * any of them as a failure makes one bad CV build look like four broken calls, which is the number
 * an operator would act on. The taxonomy is derived, never stored: no column, and older rows
 * classify the same way as new ones.
 * ------------------------------------------------------------------------------------------- */

export const AI_OUTCOMES = ["ok", "cancelled", "stalled", "failed"] as const;
export type AiOutcome = (typeof AI_OUTCOMES)[number];

/**
 * The prefixes packages/ai writes for the calls it stopped itself: a batch cancelled because a
 * sibling failed, and a call its run stopped at the task deadline or for a lost lease. All three
 * are the deployment deciding to stop paying, so all three are `cancelled`; the label says which.
 * Its own test pins them from that end.
 */
const CANCELLED_PREFIXES = ["Cancelled because another call", "Stopped at the task deadline:", "Stopped by the worker:"];
const STALLED_PREFIX = "Stream timed out:";
/**
 * The labels of an answer the model gave that could not be used: it declined, ran out of room,
 * left a server-tool turn unfinished, or returned something the schema rejects. Each is a failure of the call, but the provider served
 * it, so none of them is evidence of an outage.
 */
const ANSWER_PREFIXES = ["refusal:", "Model output limit reached", "schema rejected:", "no parseable output", "Server tool turn still paused"];

/** What one recorded call actually was. `ok` and `error` are all it takes. */
export function aiOutcome(row: { ok: boolean; error?: string | null }): AiOutcome {
  if (row.ok) return "ok";
  const error = row.error ?? "";
  if (CANCELLED_PREFIXES.some((prefix) => error.startsWith(prefix))) return "cancelled";
  if (error.startsWith(STALLED_PREFIX)) return "stalled";
  return "failed";
}

const startsWithAny = (prefixes: string[]) =>
  sql.join(prefixes.map((prefix) => sql`coalesce(error, '') like ${prefix + "%"}`), sql` or `);

/** The same rule in SQL, so an aggregate and a row can never disagree about one call. */
export const aiOutcomeSql = sql`case
  when ok then 'ok'
  when ${startsWithAny(CANCELLED_PREFIXES)} then 'cancelled'
  when error like ${STALLED_PREFIX + "%"} then 'stalled'
  else 'failed' end`;

/**
 * Whether a failed call is the provider's failure: a transport error, a rate limit, an overload,
 * a refused key or a stalled stream. What outage detection may count — never a call the engine
 * stopped itself, and never an answer the model gave that the call site could not use.
 */
export function isAiProviderFailure(row: { ok: boolean; error?: string | null }): boolean {
  const outcome = aiOutcome(row);
  if (outcome === "ok" || outcome === "cancelled") return false;
  const error = row.error ?? "";
  return !ANSWER_PREFIXES.some((prefix) => error.startsWith(prefix));
}

/** The same rule in SQL, as a predicate over an `ai_calls` row. */
export const aiProviderFailureSql = sql`(not ok and not (${startsWithAny(CANCELLED_PREFIXES)}) and not (${startsWithAny(ANSWER_PREFIXES)}))`;

/** One line per account, call site and model: what was spent, what it bought, and how it behaved. */
export interface AiAccountUsage {
  /** null for shared work with no account behind it, such as extraction and discovery. */
  userId: string | null;
  callSite: string;
  model: string;
  calls: number;
  /** Calls the model let us down on. They were still billed, so they still count. */
  failed: number;
  /** Calls the engine stopped paying for: a sibling had already failed, or the task's run was stopped. */
  cancelled: number;
  /** Streams cut off at the stall ceiling: a vendor symptom, not a broken prompt. */
  stalled: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** Wall time the caller waited, in ms; null until a row in this group recorded one. */
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  /** cache_read / (input + cache_read + cache_write): how much of the prompt the cache served. */
  cacheHitRatio: number | null;
}

/**
 * Spend since `since` grouped by account, call site and model, dearest first.
 *
 * Cost answers "what did this bill"; latency and the cache ratio answer "why", which is the
 * question a dear line actually raises. Failures are split by `aiOutcome` so a cancelled sibling
 * batch never reads as the model failing four times.
 */
export async function aiUsageByAccount(db: Db, since: Date): Promise<AiAccountUsage[]> {
  const rows = await db.execute<AiAccountUsage & Record<string, unknown>>(sql`select
      user_id as "userId",
      call_site as "callSite",
      model,
      count(*)::int as calls,
      count(*) filter (where ${aiOutcomeSql} = 'failed')::int as failed,
      count(*) filter (where ${aiOutcomeSql} = 'cancelled')::int as cancelled,
      count(*) filter (where ${aiOutcomeSql} = 'stalled')::int as stalled,
      coalesce(sum(input_tokens), 0)::int as "inputTokens",
      coalesce(sum(output_tokens), 0)::int as "outputTokens",
      coalesce(sum(cache_read_tokens), 0)::int as "cacheReadTokens",
      coalesce(sum(cache_write_tokens), 0)::int as "cacheWriteTokens",
      coalesce(sum(cost_usd::float8), 0) as "costUsd",
      percentile_cont(0.5) within group (order by duration_ms) filter (where duration_ms is not null) as "p50DurationMs",
      percentile_cont(0.95) within group (order by duration_ms) filter (where duration_ms is not null) as "p95DurationMs",
      nullif(sum(input_tokens + cache_read_tokens + cache_write_tokens), 0)::float8 as "promptTokens"
    from ai_calls where at >= ${since}
    group by user_id, call_site, model
    order by coalesce(sum(cost_usd::float8), 0) desc, call_site asc, model asc`);
  return rows.rows.map((row) => {
    const cacheReadTokens = Number(row.cacheReadTokens);
    const promptTokens = row.promptTokens === null || row.promptTokens === undefined ? null : Number(row.promptTokens);
    return {
      userId: row.userId ?? null,
      callSite: row.callSite,
      model: row.model,
      calls: Number(row.calls),
      failed: Number(row.failed),
      cancelled: Number(row.cancelled),
      stalled: Number(row.stalled),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cacheReadTokens,
      cacheWriteTokens: Number(row.cacheWriteTokens),
      costUsd: Number(row.costUsd),
      p50DurationMs: numberOrNull(row.p50DurationMs),
      p95DurationMs: numberOrNull(row.p95DurationMs),
      cacheHitRatio: promptTokens ? cacheReadTokens / promptTokens : null,
    };
  });
}

const numberOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number.isFinite(Number(value)) ? Number(value) : null;

/* ---------------------------------------------------------------------------------------------
 * Explaining one build, and one scored role
 *
 * The month's total says a CV builder is expensive. It does not say whether a dear build read a
 * long job description, wrote three times over, or paid twice for a batch whose attribution had to
 * be corrected. `ref_id` names the draft and `stage` names the step, so a build is a bill with
 * lines on it. Both reads are the operator's, across every account: they are called only behind
 * `requireAdmin`.
 * ------------------------------------------------------------------------------------------- */

/** One CV draft's model bill, broken down by the step that incurred it. */
export interface CvBuildCost {
  draftId: string;
  calls: number;
  costUsd: number;
  /** Cost per stage, e.g. `{ rubric: 0.4, author: 1.2, review: 1.5, review_retry: 0.3 }`. */
  byStage: Record<string, number>;
  /** Calls the engine recorded without a stage — a build from before stages were written. */
  unattributedUsd: number;
  at: Date;
}

export interface CvBuildCosts {
  builds: CvBuildCost[];
  medianUsd: number | null;
  worstUsd: number | null;
  /** The stages, dearest first across the sampled builds, for a stable column order. */
  stages: string[];
}

/** How far back the sampled builds may reach: an Operations page reads this month's costs, not the ledger's history. */
const CV_BUILD_COST_WINDOW = sql`now() - interval '90 days'`;

/**
 * The last `limit` CV builds that spent anything, newest first, each one itemised by stage. The
 * sample is taken from the last ninety days, so the grouping walks a bounded slice of the ledger
 * rather than every CV call ever made.
 */
export async function costPerCvBuild(db: Db, limit = 20): Promise<CvBuildCosts> {
  const rows = await db.execute<{ draftId: string; stage: string | null; calls: number; costUsd: number; at: Date }>(sql`
    with builds as (
      select ref_id, max(at) as last_at from ai_calls
      where ref_type like 'cv-%' and ref_id is not null and at >= ${CV_BUILD_COST_WINDOW}
      group by ref_id order by max(at) desc limit ${limit}
    )
    select c.ref_id as "draftId", c.stage, count(*)::int as calls,
      coalesce(sum(c.cost_usd::float8), 0) as "costUsd", max(c.at) as at
    from ai_calls c join builds on builds.ref_id = c.ref_id
    where c.ref_type like 'cv-%'
    group by c.ref_id, c.stage, builds.last_at
    order by builds.last_at desc, c.stage nulls last`);
  const byDraft = new Map<string, CvBuildCost>();
  const stageTotals = new Map<string, number>();
  for (const row of rows.rows) {
    let build = byDraft.get(row.draftId);
    if (!build) {
      build = { draftId: row.draftId, calls: 0, costUsd: 0, byStage: {}, unattributedUsd: 0, at: row.at };
      byDraft.set(row.draftId, build);
    }
    const cost = Number(row.costUsd);
    build.calls += Number(row.calls);
    build.costUsd += cost;
    if (row.at > build.at) build.at = row.at;
    if (row.stage) {
      build.byStage[row.stage] = (build.byStage[row.stage] ?? 0) + cost;
      stageTotals.set(row.stage, (stageTotals.get(row.stage) ?? 0) + cost);
    } else {
      build.unattributedUsd += cost;
    }
  }
  const builds = [...byDraft.values()];
  const costs = builds.map((build) => build.costUsd).sort((a, b) => a - b);
  return {
    builds,
    medianUsd: median(costs),
    worstUsd: costs.length ? costs[costs.length - 1]! : null,
    stages: [...stageTotals.entries()].sort((a, b) => b[1] - a[1]).map(([stage]) => stage),
  };
}

/** What scoring one role costs: A5 is the highest-volume call site, so its unit price is the one to watch. */
export interface ScoredRoleCost {
  roles: number;
  calls: number;
  totalUsd: number;
  meanUsd: number | null;
  medianUsd: number | null;
}

/** A5 against a job, over `days`, as a cost per role rather than a month's lump. */
export async function costPerScoredRole(db: Db, days = 30): Promise<ScoredRoleCost> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db.execute<{ roles: number; calls: number; totalUsd: number; meanUsd: number | null; medianUsd: number | null }>(sql`
    with per_role as (
      select ref_id, count(*)::int as calls, sum(cost_usd::float8) as cost
      from ai_calls where call_site = 'A5' and ref_type = 'job' and ref_id is not null and at >= ${since}
      group by ref_id
    )
    select count(*)::int as roles, coalesce(sum(calls), 0)::int as calls,
      coalesce(sum(cost), 0) as "totalUsd", avg(cost) as "meanUsd",
      percentile_cont(0.5) within group (order by cost) as "medianUsd"
    from per_role`);
  const row = rows.rows[0];
  return {
    roles: Number(row?.roles ?? 0),
    calls: Number(row?.calls ?? 0),
    totalUsd: Number(row?.totalUsd ?? 0),
    meanUsd: numberOrNull(row?.meanUsd),
    medianUsd: numberOrNull(row?.medianUsd),
  };
}

/** Median of an already ascending list. */
function median(sorted: readonly number[]): number | null {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** What a release of holds gave back. */
export interface ReleasedHolds {
  count: number;
  amountUsd: number;
}

/**
 * Drop `ai_reservations` that nothing can still be spending, and say what they were holding.
 *
 * A hold is taken before a model call and released after it, so the only thing that ever leaves
 * one behind is a process that died mid-call. Two callers need to clear those: a worker giving up
 * its own holds (by `workerId`, on shutdown or on the boot that follows an unclean exit — two
 * processes cannot share a pod name, so its own id can only name dead holds), and a task given up
 * on, which releases the hold its account was still being charged capacity for.
 *
 * A scope is mandatory. Without one this would clear every account's live holds, so a caller that
 * names neither a worker nor an account is a bug rather than a cleanup. A caller giving up on one
 * piece of work names it with `refId`: scoped to the account alone, abandoning one CV build
 * released a sibling build's hold too, whose renewal then silently updated nothing and whose
 * capacity the budget forgot — which is how a month admitted a third build it could not afford.
 */
export async function releaseAiHolds(
  db: Db,
  scope: { workerId?: string | null; userId?: string | null; callSite?: string | null; refId?: string | null },
): Promise<ReleasedHolds> {
  if (!scope.workerId && !scope.userId) throw new Error("releaseAiHolds needs a worker or an account to scope the release");
  const conditions = [sql`true`];
  if (scope.workerId) conditions.push(sql`worker_id = ${scope.workerId}`);
  if (scope.userId) conditions.push(sql`user_id = ${scope.userId}`);
  if (scope.callSite) conditions.push(sql`call_site = ${scope.callSite}`);
  // What the hold was taken for. An account can have two builds in flight, each holding its own
  // share of the budget; giving up on one must give back that one's hold and nothing else.
  if (scope.refId) conditions.push(sql`ref_id = ${scope.refId}`);
  const rows = await db.execute<{ amount: number }>(
    sql`delete from ai_reservations where ${sql.join(conditions, sql` and `)} returning amount`,
  );
  const amountUsd = rows.rows.reduce((total, row) => total + Number(row.amount ?? 0), 0);
  return { count: rows.rows.length, amountUsd: Math.round(amountUsd * 100) / 100 };
}

/**
 * A CV hold exists to cover one build in flight. When the build it was taken for has no task
 * queued or running any more, the hold is dead: the worker that took it crashed under another pod
 * name, or the draft was discarded mid-build. Left alone it counts against that account's budget
 * for the life of the reservation and refuses the next build for no reason. The grace keeps it
 * away from a hold taken a moment before its task row is visible.
 *
 * A hold that names its build is judged by that build alone, so an account running two builds
 * keeps the hold of the one still going. Holds from before `ref_id` existed are judged by the old
 * rule — any CV task of that account — which is the safe direction: it keeps a hold the account
 * may still need rather than releasing capacity something is spending.
 */
export async function releaseOrphanedCvHolds(db: Db, graceMinutes = 2): Promise<ReleasedHolds> {
  const rows = await db.execute<{ amount: number }>(sql`
    delete from ai_reservations r
    where r.call_site = 'CV'
      and r.created_at < now() - make_interval(mins => ${graceMinutes}::int)
      and case when r.ref_id is not null
        then not exists (
          select 1 from tasks t
          where t.type = 'generate_cv'
            and t.payload->>'draftId' = r.ref_id
            and t.status in ('queued', 'running')
        )
        else not exists (
          select 1 from tasks t
          join cv_drafts d on t.type = 'generate_cv' and t.payload->>'draftId' = d.id::text
          where d.user_id = r.user_id and t.status in ('queued', 'running')
        )
      end
    returning r.amount`);
  const amountUsd = rows.rows.reduce((total, row) => total + Number(row.amount ?? 0), 0);
  return { count: rows.rows.length, amountUsd: Math.round(amountUsd * 100) / 100 };
}

/**
 * What one finished model call is recorded as. Structural, so the ledger does not depend on the
 * engine: `AiUsageRecord` satisfies it, and the account is passed separately because shared work
 * (extraction, discovery) has none while every CV call has one.
 */
export interface AiCallRecord {
  /**
   * The row's id, when the caller chooses it. A caller that retries a write whose acknowledgement
   * was lost passes the same id each time, so a commit that did land is not written twice.
   */
  id?: string;
  callSite: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
  ok: boolean;
  error?: string | null;
  refType?: string | null;
  refId?: string | null;
  stage?: string | null;
}

/**
 * Append one call to `ai_calls`, the only record of what was spent.
 *
 * Every engine writes through here, so a column added to the ledger reaches every call site at
 * once: the two that existed had drifted into writing different subsets of the row, and a budget
 * read from a table missing one of them is wrong in the direction that spends money. With an `id`
 * the write is idempotent: the same id again writes nothing.
 */
export async function recordAiCall(db: Pick<Db, "insert">, userId: string | null, record: AiCallRecord): Promise<void> {
  await db.insert(aiCalls).values({
    ...(record.id ? { id: record.id } : {}),
    userId,
    callSite: record.callSite,
    model: record.model,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheWriteTokens: record.cacheWriteTokens,
    costUsd: record.costUsd,
    durationMs: record.durationMs,
    ok: record.ok,
    error: record.error ?? null,
    refType: record.refType ?? null,
    refId: record.refId ?? null,
    stage: record.stage ?? null,
  }).onConflictDoNothing({ target: aiCalls.id });
}
