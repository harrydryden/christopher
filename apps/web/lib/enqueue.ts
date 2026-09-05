import { enqueueTask } from "@christopher/db";
import { dedupeKeyFor, priorityFor, type TaskPayloads, type TaskType } from "@christopher/core";
import { db } from "./db";

/** Enqueue a worker task with the standard dedupe key and priority for its type. */
export async function enqueue<T extends TaskType>(type: T, payload: TaskPayloads[T]): Promise<string | null> {
  return enqueueTask(db(), type, payload as unknown as Record<string, unknown>, {
    dedupeKey: dedupeKeyFor(type, payload),
    priority: priorityFor(type),
  });
}
