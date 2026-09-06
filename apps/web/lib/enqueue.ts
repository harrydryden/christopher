import { sql } from "drizzle-orm";
import { tasks } from "@christopher/db/schema";
import { dedupeKeyFor, priorityFor, type TaskPayloads, type TaskType } from "@christopher/core";
import { db } from "./db";

/**
 * Enqueue a worker task with the standard dedupe key and priority for its type.
 * Reimplements `enqueueTask` from `@christopher/db` locally — see lib/db.ts for why the
 * web app avoids importing that package's root barrel.
 */
export async function enqueue<T extends TaskType>(type: T, payload: TaskPayloads[T]): Promise<string | null> {
  const rows = await db()
    .insert(tasks)
    .values({
      type,
      payload: payload as unknown as Record<string, unknown>,
      dedupeKey: dedupeKeyFor(type, payload),
      priority: priorityFor(type),
      runAfter: sql`now()`,
      maxAttempts: 3,
    })
    .onConflictDoNothing()
    .returning({ id: tasks.id });
  return rows[0]?.id ?? null;
}
