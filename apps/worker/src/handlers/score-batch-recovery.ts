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
  const priority = priorityFor("score_job");
  const rows = items.map(item => {
    const payload = { userId: item.userId, jobId: item.jobId, live: true };
    return { type: "score_job" as const, payload, dedupeKey: dedupeKeyFor("score_job", payload), priority };
  });
  // One transaction: a task marked live here wakes a listening worker as it commits, as a new
  // one does through `enqueueTasks`, so the queue claims it at once rather than on its next poll.
  await db.transaction(async tx => {
    const marked = await tx.execute(sql`update tasks set payload = payload || '{"live": true}'::jsonb, priority = least(priority, ${priority}::int), run_after = least(run_after, now())
      where type = 'score_job' and status = 'queued' and started_at is null
        and dedupe_key in (${sql.join(rows.map(row => sql`${row.dedupeKey}`), sql`, `)})`);
    if (marked.rowCount) await notifyTaskWorkers(tx);
    await enqueueTasks(tx, rows);
  });
  return rows.length;
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
