import { enqueueTask } from "@christopher/db/tasks";
import { dedupeKeyFor, priorityFor, type TaskPayloads, type TaskType } from "@christopher/core";
import { db } from "./db";

type TaskWriter = Pick<ReturnType<typeof db>, "insert">;

/** Enqueue with standard task defaults, optionally inside the caller's transaction. */
export async function enqueue<T extends TaskType>(type: T, payload: TaskPayloads[T], writer: TaskWriter = db()): Promise<string | null> {
  return enqueueTask(writer, type, payload as unknown as Record<string, unknown>, {
    dedupeKey: dedupeKeyFor(type, payload),
    priority: type === "score_job" ? 1 : priorityFor(type),
  });
}
