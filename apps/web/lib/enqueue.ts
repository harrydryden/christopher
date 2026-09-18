import { enqueueTask } from "@christopher/db/tasks";
import { dedupeKeyFor, priorityFor, type TaskPayloads, type TaskType } from "@christopher/core";
import { tasks } from "@christopher/db/schema";
import { db } from "./db";

type TaskWriter = Pick<ReturnType<typeof db>, "insert">;

/** Enqueue with standard task defaults, optionally inside the caller's transaction. */
export async function enqueue<T extends TaskType>(type: T, payload: TaskPayloads[T], writer: TaskWriter = db()): Promise<string | null> {
  return enqueueTask(writer, type, payload as unknown as Record<string, unknown>, {
    dedupeKey: dedupeKeyFor(type, payload),
    priority: type === "score_job" ? 1 : priorityFor(type),
  });
}

/**
 * Enqueue one task per payload in a single insert, with the same defaults and dedupe keys
 * `enqueue` uses. The partial unique index on `dedupe_key` settles duplicates — both against
 * tasks already queued and between rows of this statement — so a group action queues exactly
 * what the same roles decided one at a time would.
 */
export async function enqueueMany<T extends TaskType>(type: T, payloads: TaskPayloads[T][], writer: TaskWriter = db()): Promise<void> {
  if (!payloads.length) return;
  await writer
    .insert(tasks)
    .values(payloads.map(payload => ({
      type,
      payload: payload as unknown as Record<string, unknown>,
      dedupeKey: dedupeKeyFor(type, payload),
      priority: type === "score_job" ? 1 : priorityFor(type),
    })))
    .onConflictDoNothing();
}
