import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./client";
import { tasks } from "./schema";

export interface EnqueueOptions {
  dedupeKey?: string | null;
  priority?: number;
  runAfter?: Date;
  maxAttempts?: number;
}

/**
 * Insert a task unless an identical dedupe key is already queued or running.
 * Returns the task id, or null when deduplicated.
 */
export async function enqueueTask(
  db: Pick<Db, "insert">,
  type: (typeof tasks.$inferInsert)["type"],
  payload: Record<string, unknown>,
  options: EnqueueOptions = {},
): Promise<string | null> {
  const rows = await db
    .insert(tasks)
    .values({
      type,
      payload,
      dedupeKey: options.dedupeKey ?? null,
      priority: options.priority ?? 5,
      runAfter: options.runAfter ?? sql`now()`,
      maxAttempts: options.maxAttempts ?? 3,
    })
    .onConflictDoNothing()
    .returning({ id: tasks.id });
  return rows[0]?.id ?? null;
}

/** One row for `enqueueTasks`: a task with the same options `enqueueTask` takes. */
export interface EnqueueRow extends EnqueueOptions {
  type: (typeof tasks.$inferInsert)["type"];
  payload: Record<string, unknown>;
}

/**
 * Insert many tasks in multi-row statements, with the defaults `enqueueTask` uses and the same
 * dedupe rule: a row whose key is already queued or running — or repeated within the batch — is
 * skipped. Returns how many were inserted. `chunkSize` bounds one statement's parameters.
 */
export async function enqueueTasks(db: Pick<Db, "insert">, rows: EnqueueRow[], chunkSize = 250): Promise<number> {
  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const ids = await db
      .insert(tasks)
      .values(chunk.map(row => ({
        type: row.type,
        payload: row.payload,
        dedupeKey: row.dedupeKey ?? null,
        priority: row.priority ?? 5,
        runAfter: row.runAfter ?? sql`now()`,
        maxAttempts: row.maxAttempts ?? 3,
      })))
      .onConflictDoNothing()
      .returning({ id: tasks.id });
    inserted += ids.length;
  }
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
