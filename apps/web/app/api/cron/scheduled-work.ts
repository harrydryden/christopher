/**
 * The work behind `/api/cron`: a scheduler tick and, where `AVA_SERVERLESS_FALLBACK=1` says there is
 * no worker service, as much of the queue as fits in one invocation.
 *
 * It lives beside the route rather than in it because a route module may export only its handlers
 * and Next's route settings, and the tests need to drive it with a small time budget and handlers
 * of their own.
 */
import { randomBytes } from "node:crypto";
import { releaseAiHolds } from "@ava/db";
import { deadlineMsFor, renamedEnv, type TaskType } from "@ava/core";
import {
  claimTask, createDeps, handlers as workerHandlers, onAbandon as workerOnAbandon, onInterrupted as workerOnInterrupted,
  readEnv, schedulerTick, TaskQueue, type HandlerMap, type QueueOptions,
} from "@ava/worker";
import { getWorkerHeartbeat } from "@/lib/queries/health";

/**
 * What the fallback never claims. A CV build that is working perfectly can take half an hour, so no
 * serverless invocation can finish one: each call would spend an attempt and the account's model
 * budget on a build that is cut off part-way. CV builds need the worker service.
 */
export const FALLBACK_EXCLUDED_TYPES: TaskType[] = ["generate_cv"];

/** A worker that reported this recently owns the schedule and the queue; the route stands down. */
const HEARTBEAT_FRESH_MS = 120_000;

/**
 * How long closing the connections may hold up the answer. A handler that was cut off keeps its
 * connection until its statement returns, and the task it held is back on the queue by then.
 */
const CLOSE_WAIT_MS = 3_000;

export interface ScheduledWorkOptions {
  /** Milliseconds from the start after which no new task is claimed. */
  claimForMs: number;
  /**
   * Milliseconds from the start by which the task in hand has been cut off. The platform ends the
   * invocation at `maxDuration` without warning, so this must leave time to record the outcome.
   */
  hardStopMs: number;
  /** Tests replace the handlers and hooks; the route runs the worker's own. */
  handlers?: HandlerMap;
  onAbandon?: QueueOptions["onAbandon"];
  onInterrupted?: QueueOptions["onInterrupted"];
}

export async function runScheduledWork(options: ScheduledWorkOptions) {
  // A serverless invocation must never launch a browser: there is no Chromium in the runtime.
  process.env.AVA_DISABLE_BROWSER = "1";
  const started = Date.now();
  const processed: string[] = [];
  let timedOut = false;

  // Read the heartbeat before anything is queued: beside a healthy worker this route does nothing
  // at all, rather than racing it to schedule the same day's run.
  const heartbeat = await getWorkerHeartbeat();
  if (heartbeat && Date.now() - heartbeat.at.getTime() < HEARTBEAT_FRESH_MS) {
    return { processed: 0, byType: {} as Record<string, number>, durationMs: Date.now() - started, timedOut, standDown: "worker" as const };
  }

  // One slot, so a pool sized for one slot. The id is this invocation's own, so the AI holds its
  // tasks take are released when it ends instead of counting against an account until they expire.
  const workerId = `vercel-cron-${randomBytes(4).toString("hex")}`;
  const deps = await createDeps({ ...readEnv(), concurrency: 1, workerId }, { settingsTtlMs: 0 });
  const drains = renamedEnv(process.env, "AVA_SERVERLESS_FALLBACK", "CHRISTOPHER_SERVERLESS_FALLBACK") === "1";
  const hardStopAt = started + options.hardStopMs;
  const claimUntil = started + options.claimForMs;

  try {
    await schedulerTick(deps);
    while (drains) {
      if (Date.now() >= claimUntil) {
        timedOut = true;
        break;
      }
      const task = await claimTask(deps.db, workerId, "all", FALLBACK_EXCLUDED_TYPES);
      if (!task) break;
      // The task's own deadline is a ceiling for a stuck handler, and most are longer than the whole
      // invocation. Capped at the time left, the queue cuts the task off itself before the platform
      // does: the run's signal aborts, the row goes back on the queue with the attempt counted (or
      // is failed on its last one), and the type's interrupted or abandon hook runs. Killed by the
      // platform instead, it stayed `running` until the next day's stale sweep.
      const cap = Math.max(1, Math.min(deadlineMsFor(task.type), hardStopAt - Date.now()));
      const queue = new TaskQueue(deps, options.handlers ?? workerHandlers, {
        concurrency: 1,
        workerId,
        deadlines: { [task.type]: cap },
        onAbandon: options.onAbandon ?? workerOnAbandon,
        onInterrupted: options.onInterrupted ?? workerOnInterrupted,
      });
      await queue.runTask(task);
      processed.push(task.type);
    }
  } finally {
    try {
      await releaseAiHolds(deps.db, { workerId });
    } catch (err) {
      console.error(JSON.stringify({ event: "cron_release_holds_failed", error: (err as Error)?.message }));
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([deps.close(), new Promise<void>(resolve => { timer = setTimeout(resolve, CLOSE_WAIT_MS); timer.unref?.(); })]);
    if (timer) clearTimeout(timer);
  }

  const counts: Record<string, number> = {};
  for (const type of processed) counts[type] = (counts[type] ?? 0) + 1;
  return { processed: processed.length, byType: counts, durationMs: Date.now() - started, timedOut, drained: drains };
}
