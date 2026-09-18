/**
 * What has been spent on AI, read straight from `ai_calls`.
 *
 * `ai_calls` is the only record of spend: every call writes one row with its real cost, so a
 * budget is a sum over a window rather than a running total that something has to keep correct.
 * Resetting a counter moves that account's window (a reset marker in its settings); nothing is
 * deleted, so the call log stays complete. Reading spend never touches `ai_reservations`: a hold
 * is capacity for a call in flight, taken and released by the worker, and deliberately not mixed
 * into what was spent. The one write here is `releaseAiHolds`, which drops holds whose call can
 * no longer be in flight.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./client";

/**
 * One account's recorded spend since `since`, in USD: what its own monthly budget counts. Work
 * that belongs to no account carries no `user_id` and is excluded.
 */
export async function accountAiSpend(db: Db, userId: string, since: Date): Promise<number> {
  const rows = await db.execute<{ total: number }>(
    sql`select coalesce(sum(cost_usd), 0)::float8 as total from ai_calls where user_id = ${userId} and at >= ${since}`,
  );
  return Number(rows.rows[0]?.total ?? 0);
}

/** Every call since `since`, whoever it was for: the deployment's report, not a budget. */
export async function totalAiSpend(db: Db, since: Date): Promise<number> {
  const rows = await db.execute<{ total: number }>(
    sql`select coalesce(sum(cost_usd), 0)::float8 as total from ai_calls where at >= ${since}`,
  );
  return Number(rows.rows[0]?.total ?? 0);
}

/** One line per account, call site and model: what was spent and what it bought. */
export interface AiAccountUsage {
  /** null for shared work with no account behind it, such as extraction and discovery. */
  userId: string | null;
  callSite: string;
  model: string;
  calls: number;
  /** Calls that returned nothing usable. They were still billed, so they still count. */
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/** Spend since `since` grouped by account, call site and model, dearest first. */
export async function aiUsageByAccount(db: Db, since: Date): Promise<AiAccountUsage[]> {
  const rows = await db.execute<AiAccountUsage & Record<string, unknown>>(sql`select
      user_id as "userId",
      call_site as "callSite",
      model,
      count(*)::int as calls,
      count(*) filter (where not ok)::int as failed,
      coalesce(sum(input_tokens), 0)::int as "inputTokens",
      coalesce(sum(output_tokens), 0)::int as "outputTokens",
      coalesce(sum(cache_read_tokens), 0)::int as "cacheReadTokens",
      coalesce(sum(cache_write_tokens), 0)::int as "cacheWriteTokens",
      coalesce(sum(cost_usd), 0)::float8 as "costUsd"
    from ai_calls where at >= ${since}
    group by user_id, call_site, model
    order by coalesce(sum(cost_usd), 0) desc, call_site asc, model asc`);
  return rows.rows.map((row) => ({
    userId: row.userId ?? null,
    callSite: row.callSite,
    model: row.model,
    calls: Number(row.calls),
    failed: Number(row.failed),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    cacheReadTokens: Number(row.cacheReadTokens),
    cacheWriteTokens: Number(row.cacheWriteTokens),
    costUsd: Number(row.costUsd),
  }));
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
 * names neither a worker nor an account is a bug rather than a cleanup.
 */
export async function releaseAiHolds(
  db: Db,
  scope: { workerId?: string | null; userId?: string | null; callSite?: string | null },
): Promise<ReleasedHolds> {
  if (!scope.workerId && !scope.userId) throw new Error("releaseAiHolds needs a worker or an account to scope the release");
  const conditions = [sql`true`];
  if (scope.workerId) conditions.push(sql`worker_id = ${scope.workerId}`);
  if (scope.userId) conditions.push(sql`user_id = ${scope.userId}`);
  if (scope.callSite) conditions.push(sql`call_site = ${scope.callSite}`);
  const rows = await db.execute<{ amount: number }>(
    sql`delete from ai_reservations where ${sql.join(conditions, sql` and `)} returning amount`,
  );
  const amountUsd = rows.rows.reduce((total, row) => total + Number(row.amount ?? 0), 0);
  return { count: rows.rows.length, amountUsd: Math.round(amountUsd * 100) / 100 };
}
