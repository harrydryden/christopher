/**
 * What batch scoring does to hand roles back to live scoring and let go of a batch's holds. Kept
 * apart from the handlers so the abandonment hooks can use it without importing every handler.
 */
import { enqueueTasks, notifyTaskWorkers } from "@ava/db/tasks";
import type { Db } from "@ava/db";
import { dedupeKeyFor, priorityFor, type ScoreBatchItem, type ScoreBatchRecord } from "@ava/core";
import { sql } from "drizzle-orm";

/**
 * Hand roles back to ordinary live scoring: one `score_job` each, marked `live` so the queue runs
 * it in batch mode too. A role that already has a task waiting is marked on that task instead, so
 * the hand-back never queues the same role twice. Returns how many roles were handed back.
 */
export async function requeueScoresLive(db: Db, items: ReadonlyArray<Pick<ScoreBatchItem, "userId" | "jobId">>): Promise<number> {
  if (!items.length) return 0;
  const pairs = [...new Map(items.map(item => [`${item.userId}:${item.jobId}`, item])).values()]
    .sort((a, b) => a.userId.localeCompare(b.userId) || a.jobId.localeCompare(b.jobId));
  const priority = priorityFor("score_job");
  const rows = pairs.map(item => {
    const payload = { userId: item.userId, jobId: item.jobId, live: true };
    return { type: "score_job" as const, payload, dedupeKey: dedupeKeyFor("score_job", payload), priority };
  });
  // One transaction: a task marked live here wakes a listening worker as it commits, as a new
  // one does through `enqueueTasks`, so the queue claims it at once rather than on its next poll.
  await db.transaction(async tx => {
    // A failed poll task is committed before its abandonment hook runs. An orphan-state sweep can
    // therefore mark an old waiting view failed just before this hand-back. Take the same view
    // locks in a stable order before changing tasks, then restore waiting only when an eligible
    // view has live score work. A newer score or request is never replaced by this older batch.
    const values = JSON.stringify(pairs);
    await tx.execute(sql`select uj.user_id, uj.job_id from user_jobs uj
      where exists (select 1 from jsonb_to_recordset(${values}::jsonb) as v("userId" uuid, "jobId" uuid)
        where v."userId" = uj.user_id and v."jobId" = uj.job_id)
      order by uj.user_id, uj.job_id for update of uj`);
    const marked = await tx.execute(sql`update tasks set payload = payload || '{"live": true}'::jsonb, priority = least(priority, ${priority}::int), run_after = least(run_after, now())
      where type = 'score_job' and status = 'queued' and started_at is null
        and dedupe_key in (${sql.join(rows.map(row => sql`${row.dedupeKey}`), sql`, `)})`);
    if (marked.rowCount) await notifyTaskWorkers(tx);
    await enqueueTasks(tx, rows);
    await tx.execute(sql`update user_jobs uj set score_state = 'queued', score_state_at = now()
      where uj.score_state in ('queued', 'failed') and uj.archived_at is null
        and exists (select 1 from jsonb_to_recordset(${values}::jsonb) as v("userId" uuid, "jobId" uuid)
          where v."userId" = uj.user_id and v."jobId" = uj.job_id)
        and exists (select 1 from jobs j where j.id = uj.job_id and j.status = 'open')
        and not exists (select 1 from decisions d where d.user_id = uj.user_id and d.job_id = uj.job_id
          and d.superseded = false and d.decision = 'skip')
        and (uj.in_table or exists (select 1 from decisions d where d.user_id = uj.user_id and d.job_id = uj.job_id
          and d.superseded = false and d.decision = 'apply'))
        and exists (select 1 from tasks t where t.type = 'score_job' and t.status in ('queued', 'running')
          and t.payload->>'userId' = uj.user_id::text and t.payload->>'jobId' = uj.job_id::text)`);
  });
  return items.length;
}

/** Let go of whatever a batch's holds still carry. */
export async function releaseScoreBatchHolds(db: Db, record: Pick<ScoreBatchRecord, "holds">): Promise<void> {
  const ids = Object.values(record.holds ?? {});
  if (ids.length) await db.execute(sql`delete from ai_reservations where id in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`);
}

/**
 * A poll task given up on for good: the batch's results could not be read however often it was
 * asked. Its roles would otherwise wait for ever, and its holds count against each account for a
 * day, so the roles are scored live and the holds let go. If the batch did end, what it cost is
 * not in the ledger: the log line says which batch to reconcile.
 */
export async function abandonScoreBatch(db: Db, record: ScoreBatchRecord): Promise<{ requeued: number }> {
  const requeued = await requeueScoresLive(db, record.items ?? []);
  await releaseScoreBatchHolds(db, record);
  return { requeued };
}
