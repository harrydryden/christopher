import { and, eq, inArray, sql } from "drizzle-orm";
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

/** One row for `enqueueTasks`: a task with the same options `enqueueTask` takes. */
export interface EnqueueRow extends EnqueueOptions {
  type: (typeof tasks.$inferInsert)["type"];
  payload: Record<string, unknown>;
}

function valuesFor(row: EnqueueRow) {
  return {
    type: row.type,
    payload: row.payload,
    dedupeKey: row.dedupeKey ?? null,
    priority: row.priority ?? 5,
    runAfter: row.runAfter ?? sql`now()`,
    maxAttempts: row.maxAttempts ?? 3,
  };
}

/** The ids of the rows actually inserted: a deduplicated or promoted row is not one. */
async function insertTasks(db: Pick<Db, "insert">, rows: EnqueueRow[], promote: boolean): Promise<string[]> {
  if (!rows.length) return [];
  // A CV build's key lives in an index of its own, and one statement can promote against one index.
  const promoted = promote ? rows.filter(row => row.type !== "generate_cv") : [];
  const dropped = promote ? rows.filter(row => row.type === "generate_cv") : rows;
  const ids: string[] = [];
  if (dropped.length) {
    const written = await db.insert(tasks).values(dropped.map(valuesFor)).onConflictDoNothing().returning({ id: tasks.id });
    ids.push(...written.map(row => row.id));
  }
  if (promoted.length) {
    const written = await db.insert(tasks).values(promoted.map(valuesFor))
      .onConflictDoUpdate({
        // `tasks_dedupe_queued_uidx`: the one task per key that is queued and has never started.
        target: tasks.dedupeKey,
        targetWhere: sql`${tasks.status} = 'queued' and ${tasks.startedAt} is null and ${tasks.type} <> 'generate_cv' and ${tasks.dedupeKey} is not null`,
        set: { priority: sql`least(${tasks.priority}, excluded.priority)`, runAfter: sql`least(${tasks.runAfter}, excluded.run_after)` },
        setWhere: sql`${tasks.priority} > excluded.priority or ${tasks.runAfter} > excluded.run_after`,
      })
      .returning({ id: tasks.id, inserted: sql<boolean>`(xmax = 0)` });
    ids.push(...written.filter(row => row.inserted).map(row => row.id));
  }
  return ids;
}

/**
 * Insert a task unless one with the same dedupe key is already waiting to start: queued and never
 * started. A task that is running does not absorb the enqueue, so work asked for while it runs
 * gets one follow-up, which the claim holds back until the running task has finished. A CV build
 * is the exception: its key is held while it is queued or running.
 * Returns the task id, or null when deduplicated (or, with `promote`, promoted).
 */
export async function enqueueTask(
  db: Pick<Db, "insert">,
  type: (typeof tasks.$inferInsert)["type"],
  payload: Record<string, unknown>,
  options: EnqueueOptions = {},
): Promise<string | null> {
  const [id] = await insertTasks(db, [{ ...options, type, payload }], options.promote === true);
  return id ?? null;
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
export async function enqueueTasks(db: Pick<Db, "insert">, rows: EnqueueRow[], chunkSize = 250, promote = false): Promise<number> {
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
    inserted += (await insertTasks(db, batch.slice(offset, offset + chunkSize), promote)).length;
  return inserted;
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
