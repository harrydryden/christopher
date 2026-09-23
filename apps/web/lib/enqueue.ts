import { enqueueTask, enqueueTasks } from "@ava/db/tasks";
import { dedupeKeyFor, priorityFor, type TaskPayloads, type TaskType } from "@ava/core";
import { db } from "./db";

type TaskWriter = Pick<ReturnType<typeof db>, "insert">;

const priority = (type: TaskType) => (type === "score_job" ? 1 : priorityFor(type));

/**
 * Enqueue with standard task defaults, optionally inside the caller's transaction. Everything the
 * interface queues is something a person just asked for, so a matching task already waiting in
 * the background is brought up to this request's priority rather than left where it was
 * (`promote`; a CV build is never promoted, which the helper enforces).
 */
export async function enqueue<T extends TaskType>(type: T, payload: TaskPayloads[T], writer: TaskWriter = db()): Promise<string | null> {
  return enqueueTask(writer, type, payload as unknown as Record<string, unknown>, {
    dedupeKey: dedupeKeyFor(type, payload),
    priority: priority(type),
    promote: true,
  });
}

/**
 * Enqueue one task per payload in bounded statements, with the same defaults, dedupe keys and
 * promotion `enqueue` uses. The partial unique index on `dedupe_key` settles duplicates — both
 * against tasks already waiting and between rows of one call — so a group action queues exactly
 * what the same roles decided one at a time would.
 */
export async function enqueueMany<T extends TaskType>(type: T, payloads: TaskPayloads[T][], writer: TaskWriter = db()): Promise<void> {
  if (!payloads.length) return;
  await enqueueTasks(writer, payloads.map(payload => ({
    type,
    payload: payload as unknown as Record<string, unknown>,
    dedupeKey: dedupeKeyFor(type, payload),
    priority: priority(type),
  })), 250, true);
}
