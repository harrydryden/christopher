/** Worker-owned admission for A5 scores. Producers ask for roles; only this layer knows whether
 * the deployed model is configured and whether each account has budget left. */
import { queueScoring, schema, type Db, type ScoreState, type Task } from "@ava/db";
import { aiBudgetWindowStart, type AppSettings, type TaskPayloads } from "@ava/core";
import { sql } from "drizzle-orm";
import type { WorkerDeps } from "./context";
import { accountsWithBudget } from "./budget";

export interface ScorePair { userId: string; jobId: string }

type Candidate = ScorePair & { reason: "closed" | "decided" | "ineligible" | null } & Record<string, unknown>;

async function markState(db: Db, pairs: ScorePair[], state: ScoreState, now: Date): Promise<number> {
  if (!pairs.length) return 0;
  const changed = await db.execute(sql`update user_jobs uj set score_state = ${state}, score_state_at = ${now}
    from jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) as v("userId" uuid, "jobId" uuid)
    where uj.user_id = v."userId" and uj.job_id = v."jobId"
      and (uj.score_state is distinct from ${state})
      and not exists (select 1 from tasks t where t.type = 'score_job' and t.status in ('queued', 'running')
        and t.payload->>'userId' = uj.user_id::text and t.payload->>'jobId' = uj.job_id::text)
      and not exists (select 1 from tasks t, jsonb_array_elements(case
        when t.type = 'poll_score_batch' and jsonb_typeof(t.payload->'items') = 'array' then t.payload->'items'
        else '[]'::jsonb end) item
        where t.type = 'poll_score_batch' and t.status in ('queued', 'running')
          and item->>'userId' = uj.user_id::text and item->>'jobId' = uj.job_id::text)`);
  return changed.rowCount ?? 0;
}

/**
 * Partition a bounded set by eligibility, runtime model availability and account budget. The
 * task's exact IDs survive changes to display state; the final per-model reservation/prepare check
 * remains authoritative after this cheap preflight.
 */
export async function admitScores(
  deps: WorkerDeps,
  pairs: ReadonlyArray<ScorePair>,
  opts: { db?: Db; priority?: number; background?: boolean; onlyUnscored?: boolean; settings?: Map<string, AppSettings> } = {},
): Promise<{ queued: number; unavailable: number; budget: number; blockedUnavailable: number; blockedBudget: number; skipped: number }> {
  const unique = [...new Map(pairs.map(pair => [`${pair.userId}:${pair.jobId}`, pair])).values()];
  if (!unique.length) return { queued: 0, unavailable: 0, budget: 0, blockedUnavailable: 0, blockedBudget: 0, skipped: 0 };
  if (unique.length > 250) throw new Error("Score admission exceeds 250 roles");
  const db = opts.db ?? deps.db;
  // Settings reads happen before row locks; provider reservations enforce the final budget after
  // admission, and the task carries the exact roles even if a score changes their display state.
  const userIds = [...new Set(unique.map(row => row.userId))];
  const settings = deps.ai.enabled ? (opts.settings ?? new Map(await Promise.all(userIds.map(async userId => [userId, await deps.userSettings(userId)] as const)))) : null;
  return db.transaction(async tx => {
    // A caller-supplied transaction already has its own task fence. Re-entering its ownership
    // callback here can recursively run gate work while that transaction holds role locks.
    if (!opts.db) await deps.assertOwnership?.(tx as unknown as Db);
    const now = deps.now();
    const result = await tx.execute<Candidate>(sql`select v."userId" as "userId", v."jobId" as "jobId",
      case when j.status <> 'open' then 'closed'
        when uj.archived_at is not null or choice.decision = 'skip' then 'decided'
        when not uj.in_table and choice.decision is distinct from 'apply' then 'ineligible'
        else null end as reason
      from jsonb_to_recordset(${JSON.stringify(unique)}::jsonb) as v("userId" uuid, "jobId" uuid)
      join user_jobs uj on uj.user_id = v."userId" and uj.job_id = v."jobId"
      join jobs j on j.id = uj.job_id
      left join lateral (select d.decision from decisions d where d.user_id = uj.user_id and d.job_id = uj.job_id
        and d.superseded = false limit 1) choice on true
      where (${!opts.onlyUnscored} or (uj.fit_score is null and uj.scored_at is null))
      for update of uj`);
    const candidates = result.rows;
    for (const reason of ["closed", "decided", "ineligible"] as const)
      await markState(tx as unknown as Db, candidates.filter(row => row.reason === reason), reason, now);
    const eligible = candidates.filter(row => row.reason === null);
    if (!eligible.length) return { queued: 0, unavailable: 0, budget: 0, blockedUnavailable: 0, blockedBudget: 0, skipped: unique.length };
    if (!deps.ai.enabled) {
      const unavailable = await markState(tx as unknown as Db, eligible, "unavailable", now);
      return { queued: 0, unavailable, budget: 0, blockedUnavailable: eligible.length, blockedBudget: 0, skipped: unique.length - eligible.length };
    }
    const users = [...new Set(eligible.map(row => row.userId))];
    const withBudget = await accountsWithBudget(tx as unknown as Db,
      users.map(userId => ({ userId, since: aiBudgetWindowStart(now, settings!.get(userId)!.aiBudgetResetAt), budgetUsd: settings!.get(userId)!.aiBudgetUsd })));
    const scorable = eligible.filter(row => withBudget.has(row.userId));
    const overBudget = eligible.filter(row => !withBudget.has(row.userId));
    const budget = await markState(tx as unknown as Db, overBudget, "budget", now);
    const queued = await queueScoring(tx as unknown as Db,
      scorable.map(row => ({ userId: row.userId, jobId: row.jobId, ...(opts.priority === undefined ? {} : { priority: opts.priority }) })),
      now, { promote: opts.priority !== undefined, background: opts.background });
    return { queued, unavailable: 0, budget, blockedUnavailable: 0, blockedBudget: overBudget.length, skipped: unique.length - eligible.length };
  });
}

export async function handleAdmitScores(task: Task, deps: WorkerDeps): Promise<unknown> {
  const payload = task.payload as unknown as TaskPayloads["admit_scores"];
  if (!payload || typeof payload.userId !== "string" || !Array.isArray(payload.jobIds) || payload.jobIds.length > 250
    || payload.jobIds.some(id => typeof id !== "string")) throw new Error("Invalid score admission request");
  return admitScores(deps, payload.jobIds.map(jobId => ({ userId: payload.userId, jobId })), {
    priority: payload.background ? undefined : 1, background: payload.background, onlyUnscored: payload.onlyUnscored,
  });
}
