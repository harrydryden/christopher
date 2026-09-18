/**
 * What the worker's own reports add up to, in three words the reader can act on.
 *
 * The heartbeat alone cannot say this. It is rewritten on every boot, so a process that crashes
 * and restarts every few minutes writes a fresh one each time and looks perfectly alive: during
 * the October incident Operations said "Worker reported 1 minute ago" for ten hours while nothing
 * finished. The restart count is what distinguishes a worker that is running from one that keeps
 * being replaced, and the heap reading is what says why.
 *
 * Pure: the queries hand it a heartbeat and two counts, and both Operations and the user-facing
 * Health page derive the same answer from it.
 */

/** Heartbeats are written every 30s; two minutes is four missed ones. */
export const HEARTBEAT_STALE_MS = 120_000;
/** One crash recovery is an incident; a second within the hour is a loop. */
export const RESTART_LOOP_PER_HOUR = 2;
/** Heap use at which the ceiling, not the work, decides what happens next. */
export const HEAP_WARN_FRACTION = 0.85;

export interface WorkerVitals {
  heapUsedMb: number;
  heapLimitMb: number;
  heapFraction: number;
  rssMb: number;
  externalMb: number;
  uptimeSeconds: number;
}

/** The heartbeat as read from `settings`. Every field the older rows lack is null. */
export interface WorkerHeartbeat {
  at: Date;
  workerId: string | null;
  aiConfigured: boolean;
  browserAvailable: boolean;
  commit: string | null;
  bootedAt: Date | null;
  vitals: WorkerVitals | null;
  active: number | null;
  concurrency: number | null;
}

export type WorkerState = "healthy" | "restarting" | "stopped";

export interface WorkerStatus {
  state: WorkerState;
  heartbeat: WorkerHeartbeat | null;
  /** Age of the last heartbeat, or null when nothing has ever reported. */
  ageMs: number | null;
  /** `crash_recovery` events in the last hour and the last 24 hours. */
  restartsLastHour: number;
  restartsLastDay: number;
  /** Heap at or above the warning fraction. Shown in warn tone; it does not by itself change the state. */
  heapPressure: boolean;
}

export function deriveWorkerStatus(input: {
  heartbeat: WorkerHeartbeat | null;
  restartsLastHour: number;
  restartsLastDay: number;
  now?: Date;
}): WorkerStatus {
  const now = input.now ?? new Date();
  const ageMs = input.heartbeat ? now.getTime() - input.heartbeat.at.getTime() : null;
  const vitals = input.heartbeat?.vitals ?? null;
  // No report, or a report old enough that four heartbeats have been missed: whatever the process
  // is doing, it is not answering, so nothing queued is moving.
  const stopped = ageMs === null || ageMs > HEARTBEAT_STALE_MS;
  const state: WorkerState = stopped
    ? "stopped"
    : input.restartsLastHour >= RESTART_LOOP_PER_HOUR
      ? "restarting"
      : "healthy";
  return {
    state,
    heartbeat: input.heartbeat,
    ageMs,
    restartsLastHour: input.restartsLastHour,
    restartsLastDay: input.restartsLastDay,
    heapPressure: !!vitals && vitals.heapFraction >= HEAP_WARN_FRACTION,
  };
}

/**
 * One plain sentence for somebody who does not run the deployment: what is wrong and what it means
 * for their scans and CVs. `null` when the worker is fine and the ordinary "reported N ago" line
 * says everything.
 */
export function workerStatusSentence(status: WorkerStatus): string | null {
  if (status.state === "stopped") {
    const minutes = status.ageMs === null ? null : Math.max(1, Math.round(status.ageMs / 60_000));
    return `The background worker has not reported${minutes === null ? "" : ` for ${minutes} ${minutes === 1 ? "minute" : "minutes"}`}; scans and CV builds are not running. An administrator can see why in Operations.`;
  }
  if (status.state === "restarting") {
    const n = status.restartsLastDay || status.restartsLastHour;
    return `The background worker has restarted ${n} ${n === 1 ? "time" : "times"} today; scans and CV builds may be interrupted. An administrator can see why in Operations.`;
  }
  return null;
}

/** The badge tone for a state, in the four status roles the design system has. */
export function workerStateTone(state: WorkerState): "green" | "amber" | "red" {
  return state === "healthy" ? "green" : state === "restarting" ? "amber" : "red";
}

/** "184 of 258 MB heap, 71%" — the reading the incident had nowhere to appear. */
export function heapSummary(vitals: WorkerVitals): string {
  return `${vitals.heapUsedMb} of ${vitals.heapLimitMb} MB heap, ${Math.round(vitals.heapFraction * 100)}%`;
}
