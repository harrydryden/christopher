import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { dedupeKeyFor, priorityFor, type TaskPayloads, type TaskType } from "@ava/core";
import type { Db } from "./client";
import { tasks } from "./schema";

export interface EnqueueOptions {
  dedupeKey?: string | null;
  priority?: number;
  runAfter?: Date;
  maxAttempts?: number;
  /**
   * When a task with the same key is already waiting to start, bring it up to this request's
   * priority and start time instead of dropping the request. A person's request — a shortlist
   * score, a gate re-evaluation after a save — used to be absorbed into the background row already
   * waiting for the same work, and waited at that row's place in the queue. The waiting row's
   * payload never changes. A CV build, whose key is held while it runs as well, is never promoted:
   * its request is dropped as before.
   */
  promote?: boolean;
}

/**
 * The channel a worker listens on for new work. A notification carries no payload: it only says
 * "claim now", and the claim decides what, so a lost or duplicated one costs nothing but a poll.
 */
export const TASKS_CHANNEL = "ava_tasks";

/** What an enqueue writes with: an insert, and the statement that wakes a listening worker. */
export type TaskWriter = Pick<Db, "insert" | "execute">;

/**
 * Wake a listening worker. Inside a transaction the notification is delivered when it commits,
 * and not at all when it rolls back, so a worker is never woken for a task it cannot see; it goes
 * through a transaction-pooling PgBouncer as well, because only LISTEN needs a session.
 */
export async function notifyTaskWorkers(db: Pick<Db, "execute">): Promise<void> {
  await db.execute(sql`select pg_notify(${TASKS_CHANNEL}, '')`);
}

/** One row for `enqueueTasks`: a task with the same options `enqueueTask` takes. */
export interface EnqueueRow extends EnqueueOptions {
  type: (typeof tasks.$inferInsert)["type"];
  payload: Record<string, unknown>;
}

/**
 * A CV build's payload names its account. A producer that knows only the draft has the draft's
 * owner added in the same statement, read from the row the task is for, so the claim's per-account
 * ordering and every ledger that reads `payload->>'userId'` see it without a second round trip.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function payloadFor(row: EnqueueRow) {
  if (row.type !== "generate_cv" || typeof row.payload.userId === "string" || typeof row.payload.draftId !== "string")
    return row.payload;
  // Compared as a uuid so the draft is found by its primary key rather than by casting every id to
  // text; an id that is not a uuid names no draft, and is left for the handler to refuse.
  if (!UUID.test(row.payload.draftId)) return row.payload;
  return sql`${JSON.stringify(row.payload)}::jsonb || coalesce((select jsonb_build_object('userId', user_id::text) from cv_drafts where id = ${row.payload.draftId}::uuid), '{}'::jsonb)`;
}

function valuesFor(row: EnqueueRow) {
  return {
    type: row.type,
    payload: payloadFor(row),
    dedupeKey: row.dedupeKey ?? null,
    priority: row.priority ?? 5,
    runAfter: row.runAfter ?? sql`now()`,
    maxAttempts: row.maxAttempts ?? 3,
  };
}

/**
 * A row for `enqueueTasks` with its type's own dedupe key and priority, typed by its payload.
 * `options` replaces either, or adds a start time or promotion.
 */
export function taskRow<T extends TaskType>(type: T, payload: TaskPayloads[T], options: EnqueueOptions = {}): EnqueueRow {
  return { type, payload: payload as unknown as Record<string, unknown>, dedupeKey: dedupeKeyFor(type, payload), priority: priorityFor(type), ...options };
}

/** `enqueueTask` with its type's own dedupe key and priority (see `taskRow`). */
export async function enqueueStandard<T extends TaskType>(db: TaskWriter, type: T, payload: TaskPayloads[T], options: EnqueueOptions = {}): Promise<string | null> {
  const row = taskRow(type, payload, options);
  return enqueueTask(db, type, row.payload, row);
}

/**
 * The ids of the rows actually inserted: a deduplicated or promoted row is not one. When anything
 * was inserted or brought forward, a listening worker is woken in the same transaction.
 */
async function insertTasks(db: TaskWriter, rows: EnqueueRow[], promote: boolean): Promise<Array<{ id: string; payload: Record<string, unknown>; inserted: boolean }>> {
  if (!rows.length) return [];
  // A CV build's key lives in an index of its own, and one statement can promote against one index.
  const promoted = promote ? rows.filter(row => row.type !== "generate_cv") : [];
  const dropped = promote ? rows.filter(row => row.type === "generate_cv") : rows;
  const accepted: Array<{ id: string; payload: Record<string, unknown>; inserted: boolean }> = [];
  let written = false;
  if (dropped.length) {
    const inserted = await db.insert(tasks).values(dropped.map(valuesFor)).onConflictDoNothing().returning({ id: tasks.id, payload: tasks.payload });
    accepted.push(...inserted.map(row => ({ ...row, inserted: true })));
    written ||= inserted.length > 0;
  }
  if (promoted.length) {
    const upserted = await db.insert(tasks).values(promoted.map(valuesFor))
      .onConflictDoUpdate({
        // `tasks_dedupe_queued_uidx`: the one task per key that is queued and has never started.
        target: tasks.dedupeKey,
        targetWhere: sql`${tasks.status} = 'queued' and ${tasks.startedAt} is null and ${tasks.type} <> 'generate_cv' and ${tasks.dedupeKey} is not null`,
        // A promoted score is one somebody now waits on, so it stops being background work.
        set: {
          priority: sql`least(${tasks.priority}, excluded.priority)`, runAfter: sql`least(${tasks.runAfter}, excluded.run_after)`,
          payload: sql`case when ${tasks.type} = 'admit_scores'
            then case when ${tasks.payload} ? 'background' and excluded.payload ? 'background'
              then excluded.payload else excluded.payload - 'background' end
            when excluded.payload ? 'background' then ${tasks.payload} else ${tasks.payload} - 'background' end`,
        },
        setWhere: sql`${tasks.priority} > excluded.priority or ${tasks.runAfter} > excluded.run_after
          or (${tasks.payload} ? 'background' and not excluded.payload ? 'background')`,
      })
      .returning({ id: tasks.id, payload: tasks.payload, inserted: sql<boolean>`(xmax = 0)` });
    accepted.push(...upserted);
    // A promoted row is work that can start sooner, which is worth a wake as much as a new one.
    written ||= upserted.length > 0;
  }
  if (written) await notifyTaskWorkers(db);
  return accepted;
}

/**
 * Insert a task unless one with the same dedupe key is already waiting to start: queued and never
 * started. A task that is running does not absorb the enqueue, so work asked for while it runs
 * gets one follow-up, which the claim holds back until the running task has finished. A CV build
 * is the exception: its key is held while it is queued or running.
 * Returns the task id, or null when deduplicated (or, with `promote`, promoted).
 */
export async function enqueueTask(
  db: TaskWriter,
  type: (typeof tasks.$inferInsert)["type"],
  payload: Record<string, unknown>,
  options: EnqueueOptions = {},
): Promise<string | null> {
  const [row] = await insertTasks(db, [{ ...options, type, payload }], options.promote === true);
  return row?.inserted ? row.id : null;
}

/**
 * Insert many tasks in multi-row statements, with the defaults `enqueueTask` uses and the same
 * dedupe rule: a row whose key already has a task waiting to start — or is repeated within the
 * batch — is skipped. Returns how many were inserted. `chunkSize` bounds one statement's
 * parameters.
 *
 * With `promote`, a batch that names one key twice keeps its most urgent row, because one
 * statement may not update the same row twice.
 */
export async function enqueueTasks(db: TaskWriter, rows: EnqueueRow[], chunkSize = 250, promote = false): Promise<number> {
  let batch = rows;
  if (promote) {
    const byKey = new Map<string, EnqueueRow>();
    const unkeyed: EnqueueRow[] = [];
    for (const row of rows) {
      if (!row.dedupeKey) { unkeyed.push(row); continue; }
      const held = byKey.get(row.dedupeKey);
      if (!held || (row.priority ?? 5) < (held.priority ?? 5)) byKey.set(row.dedupeKey, row);
    }
    batch = [...byKey.values(), ...unkeyed];
  }
  let inserted = 0;
  for (let offset = 0; offset < batch.length; offset += chunkSize)
    inserted += (await insertTasks(db, batch.slice(offset, offset + chunkSize), promote)).filter(row => row.inserted).length;
  return inserted;
}

/**
 * Queue a score for each (account, role) admitted by the worker. Through
 * `insertTasks`, so a listening worker is woken rather than left to its idle poll. A pair's
 * `priority` replaces the ordinary one; `promote` brings a waiting score up to it. `background`
 * marks the tasks for the batch collector (a rescore pass nobody waits on). Returns how many tasks
 * were inserted.
 */
export async function queueScoring(
  db: Db,
  pairs: ReadonlyArray<{ userId: string; jobId: string; priority?: number }>,
  now: Date,
  opts: { promote?: boolean; background?: boolean } = {},
): Promise<number> {
  let queued = 0;
  for (let offset = 0; offset < pairs.length; offset += 250) {
    const batch = pairs.slice(offset, offset + 250);
    queued += await db.transaction(async tx => {
      // A score request, orphan repair and provider-batch hand-back all lock the view before
      // touching task rows. Keep this exported helper in the same order even outside admission.
      await tx.execute(sql`select uj.user_id, uj.job_id from user_jobs uj
        join jsonb_to_recordset(${JSON.stringify(batch.map(({ userId, jobId }) => ({ userId, jobId })))}::jsonb)
          as v("userId" uuid, "jobId" uuid) on uj.user_id = v."userId" and uj.job_id = v."jobId"
        order by uj.user_id, uj.job_id for update of uj`);
      const accepted = await insertTasks(tx, batch.map(({ userId, jobId, priority }) =>
        taskRow("score_job", opts.background ? { userId, jobId, background: true } : { userId, jobId },
          priority === undefined ? {} : { priority })), opts.promote === true);
      if (accepted.length) await tx.execute(sql`update user_jobs uj set score_state = 'queued', score_state_at = ${now}
        from jsonb_to_recordset(${JSON.stringify(accepted.map(row => ({ userId: row.payload.userId, jobId: row.payload.jobId })))}::jsonb) as v("userId" uuid, "jobId" uuid)
        where uj.user_id = v."userId" and uj.job_id = v."jobId"`);
      return accepted.filter(row => row.inserted).length;
    });
  }
  return queued;
}

/**
 * Record exact web-origin score requests without claiming a model is available. The request task
 * is the durable ledger: a score result may change a view's state before admission runs. Callers
 * may pass a transaction, in which case request, view state and wake-up commit together.
 */
export async function requestScores(
  db: Db,
  pairs: ReadonlyArray<{ userId: string; jobId: string }>,
  now: Date,
  opts: { priority?: number; background?: boolean; onlyUnscored?: boolean } = {},
): Promise<number> {
  const byUser = new Map<string, Set<string>>();
  for (const { userId, jobId } of pairs) {
    const jobs = byUser.get(userId) ?? new Set<string>();
    jobs.add(jobId);
    byUser.set(userId, jobs);
  }
  let queued = 0;
  for (const [userId, ids] of byUser) {
    const jobIds = [...ids].sort();
    for (let offset = 0; offset < jobIds.length; offset += 250) {
      const chunk = jobIds.slice(offset, offset + 250);
      queued += await db.transaction(async tx => {
        const requested = await tx.execute<{ job_id: string }>(sql`update user_jobs uj set score_state = 'requested', score_state_at = ${now}
          where uj.user_id = ${userId}::uuid and uj.job_id in (${sql.join(chunk.map(id => sql`${id}::uuid`), sql`, `)})
            and (${!opts.onlyUnscored} or (uj.fit_score is null and uj.scored_at is null))
          returning uj.job_id`);
        const actual = requested.rows.map(row => row.job_id).sort();
        if (!actual.length) return 0;
        const requestKey = createHash("sha1").update(JSON.stringify([actual, !!opts.onlyUnscored])).digest("hex");
        const payload = { userId, jobIds: actual, requestKey,
          ...(opts.background ? { background: true } : {}),
          ...(opts.onlyUnscored ? { onlyUnscored: true } : {}) };
        const admitted = await insertTasks(tx, [taskRow("admit_scores", payload, {
          priority: opts.priority ?? (opts.background ? 4 : 1),
        })], true);
        return admitted.filter(row => row.inserted).length;
      });
    }
  }
  return queued;
}

export async function pendingTaskCounts(db: Db) {
  const rows = await db
    .select({ type: tasks.type, status: tasks.status, n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(inArray(tasks.status, ["queued", "running"]))
    .groupBy(tasks.type, tasks.status);
  return rows;
}

export async function taskById(db: Db, id: string) {
  const rows = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function activeTaskFor(db: Db, dedupeKey: string) {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.dedupeKey, dedupeKey), inArray(tasks.status, ["queued", "running"])))
    .limit(1);
  return rows[0] ?? null;
}
