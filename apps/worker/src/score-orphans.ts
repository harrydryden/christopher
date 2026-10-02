/**
 * Repair historical score labels whose durable work has ended or disappeared. This is deliberately
 * separate from provider admission: it never queues a model call or changes a saved fit score.
 */
import type { Db } from "@ava/db";
import { sql } from "drizzle-orm";

export const SCORE_ORPHAN_BATCH = 200;
export const SCORE_ORPHAN_BUDGET_MS = 15_000;

export interface ScoreOrphanOptions {
  batch?: number;
  budgetMs?: number;
  signal?: AbortSignal;
  /** Monotonic time for the run budget; inject only in tests. */
  clock?: () => number;
}

export interface ScoreOrphanResult {
  /** Views changed to failed. */
  rows: number;
  /** Candidate views locked and rechecked, including ones a concurrent owner took over. */
  examined: number;
  backlog: boolean;
  error?: string;
}

// All current producers stamp score_state_at. Null is a historical row and is eligible without
// an age test. The grace avoids labelling very recent, unsettled work as failed; row locking and
// the fresh task check settle concurrent transactions. It is not a task deadline, and an
// arbitrarily old active task remains authoritative.
const stale = sql`(uj.score_state_at is null or uj.score_state_at < now() - interval '10 minutes')`;

/** Exact account/role ownership, independent of the view's mutable timestamp or old task age. */
const withoutOwner = sql`
  not exists (select 1 from tasks t where t.type = 'admit_scores' and t.status in ('queued', 'running')
    and t.payload->>'userId' = uj.user_id::text and t.payload->'jobIds' ? uj.job_id::text)
  and not exists (select 1 from tasks t where t.type = 'score_job' and t.status in ('queued', 'running')
    and t.payload->>'userId' = uj.user_id::text and t.payload->>'jobId' = uj.job_id::text)
  and not exists (select 1 from tasks t where t.type = 'poll_score_batch' and t.status in ('queued', 'running')
    and exists (select 1 from jsonb_array_elements(case
      when jsonb_typeof(t.payload->'items') = 'array' then t.payload->'items'
      else '[]'::jsonb end) item
      where item->>'userId' = uj.user_id::text and item->>'jobId' = uj.job_id::text))`;

async function reconcileBatch(db: Db, limit: number): Promise<{ examined: number; rows: number }> {
  return db.transaction(async tx => {
    // Keep even a poor plan or unrelated DDL lock from consuming the hourly maintenance slot.
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(sql`set local lock_timeout = '250ms'`);
    const selected = await tx.execute<{ user_id: string; job_id: string }>(sql`select uj.user_id, uj.job_id from user_jobs uj
      where uj.score_state in ('requested', 'queued') and ${stale} and ${withoutOwner}
      order by uj.score_state_at asc nulls first, uj.user_id, uj.job_id
      limit ${limit} for update of uj skip locked`);
    if (!selected.rows.length) return { examined: 0, rows: 0 };
    const pairs = selected.rows.map(row => ({ userId: row.user_id, jobId: row.job_id }));
    // This is a new READ COMMITTED statement after the view locks. A request that had the view
    // before us commits its task before this check; a later request waits until we commit.
    const changed = await tx.execute(sql`update user_jobs uj set score_state = 'failed', score_state_at = now()
      from jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) as v("userId" uuid, "jobId" uuid)
      where uj.user_id = v."userId" and uj.job_id = v."jobId"
        and uj.score_state in ('requested', 'queued') and ${stale} and ${withoutOwner}`);
    return { examined: selected.rows.length, rows: changed.rowCount ?? 0 };
  }, { isolationLevel: "read committed" });
}

/** An hourly, bounded pass. Active rows are excluded before LIMIT, so they cannot starve orphans. */
export async function reconcileOrphanScores(db: Db, options: ScoreOrphanOptions = {}): Promise<ScoreOrphanResult> {
  const batch = Math.max(1, Math.min(SCORE_ORPHAN_BATCH, options.batch ?? SCORE_ORPHAN_BATCH));
  const clock = options.clock ?? (() => performance.now());
  const deadline = clock() + (options.budgetMs ?? SCORE_ORPHAN_BUDGET_MS);
  let rows = 0;
  let examined = 0;
  for (;;) {
    if (options.signal?.aborted) return { rows, examined, backlog: true };
    let result: Awaited<ReturnType<typeof reconcileBatch>>;
    try {
      result = await reconcileBatch(db, batch);
    } catch (error) {
      return { rows, examined, backlog: true, error: error instanceof Error ? error.message : String(error) };
    }
    rows += result.rows;
    examined += result.examined;
    if (result.examined < batch) return { rows, examined, backlog: false };
    if (clock() >= deadline) return { rows, examined, backlog: true };
  }
}
