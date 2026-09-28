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
  /** Event-loop delay p99 since boot, when the worker reports it. */
  eventLoopLagP99Ms?: number | null;
  /** Queries of 250 ms or longer since boot, when the worker reports it. */
  slowQueries?: number | null;
  /** The worker's database pool at the report, when one was open. */
  db?: { total: number; idle: number; waiting: number } | null;
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
  /** The model engine's stream cap and the streams open under it, when the worker reports them. */
  governor?: WorkerGovernor | null;
  /** The engine's model-access breaker: models refused after the key could not reach them. */
  breaker?: WorkerBreaker | null;
}

/** One model the worker's breaker refused, or last refused. */
export interface WorkerBreakerTrip {
  model: string;
  message: string;
  status: number | null;
  trippedAt: Date | null;
  openUntil: Date | null;
  refused: number;
}

export interface WorkerBreaker {
  open: WorkerBreakerTrip[];
  last: WorkerBreakerTrip | null;
}

/** The last `model_access` worker event: a boot probe or a call that found a model unreachable. */
export interface ModelAccessEvent {
  at: Date;
  model: string | null;
  message: string | null;
  status: number | null;
  source: string | null;
}

/**
 * Operations' one line on model access: which models the worker is refusing right now and until
 * when, the last model the key could not reach, and any stored model id that reading settings
 * replaced. `warn` is set while something needs the administrator: an open breaker, an event in
 * the last day, or a replaced setting.
 */
export function modelAccessSummary(breaker: WorkerBreaker | null | undefined, event: ModelAccessEvent | null, warnings: readonly string[], now: Date): { text: string; warn: boolean } {
  const parts: string[] = [];
  const open = (breaker?.open ?? []).filter((trip) => !trip.openUntil || trip.openUntil.getTime() > now.getTime());
  if (open.length)
    parts.push(`Refusing ${open.map((trip) => `${trip.model}${trip.openUntil ? ` until ${trip.openUntil.toISOString().slice(11, 16)} UTC` : ""}${trip.refused ? ` (${trip.refused} calls not sent)` : ""}`).join(", ")}: this key could not reach ${open.length === 1 ? "it" : "them"}`);
  const recent = event && now.getTime() - event.at.getTime() < 86_400_000;
  if (event)
    parts.push(`Last model access failure ${event.at.toISOString().slice(0, 16).replace("T", " ")} UTC${event.source === "boot" ? " at boot" : ""}: ${event.model ?? "unknown model"}${event.status ? ` (HTTP ${event.status})` : ""}${event.message ? `, ${event.message}` : ""}`);
  else parts.push("No model access failure recorded");
  if (warnings.length) parts.push(`Settings: ${warnings.join(" ")}`);
  return { text: `${parts.join(". ")}.`.replace(/\.\./g, "."), warn: open.length > 0 || !!recent || warnings.length > 0 };
}

/**
 * The engine's stream governor. `streamCap` is a per-model cap: each model may have that many
 * streams open at once. `inFlight` and `queued` are summed across every model, so the two are never
 * set beside each other as "N of a cap of M"; `models` says what each model has open.
 */
export interface WorkerGovernor {
  streamCap: number | null;
  inFlight: number | null;
  queued: number | null;
  pausedUntil: Date | null;
  models?: Array<{ model: string; inFlight: number; queued: number }>;
}

/**
 * Operations' one sentence for the governor: what is open and waiting, the cap as the per-model
 * figure it is, each busy model's own share, and the provider's pause while it lasts.
 */
export function governorSummary(governor: WorkerGovernor, now: Date): string {
  const models = (governor.models ?? []).filter((entry) => entry.inFlight > 0 || entry.queued > 0);
  let head = `Model streams: ${governor.inFlight ?? "unknown"} open`;
  if (governor.queued !== null && governor.queued > 0) head += `, ${governor.queued} waiting for a slot`;
  const parts = [head];
  if (governor.streamCap !== null) parts.push(`each model may have ${governor.streamCap} open at once`);
  if (models.length)
    parts.push(models.map((entry) => `${entry.model} ${entry.inFlight} open${entry.queued > 0 ? `, ${entry.queued} waiting` : ""}`).join("; "));
  if (governor.pausedUntil && governor.pausedUntil.getTime() > now.getTime())
    parts.push(`paused by the provider until ${governor.pausedUntil.toISOString().slice(11, 16)} UTC`);
  return `${parts.join("; ")}.`;
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

/** Event-loop delay at which a ready callback is waiting long enough to notice: attention, not failure. */
export const EVENT_LOOP_WARN_MS = 200;

/**
 * What the worker is waiting on besides memory: its event loop, its slow queries and its pool.
 * `warn` when the loop's p99 is at the attention line or a query is waiting for a connection.
 * Null for a worker that reports none of the three.
 */
export function waitSummary(vitals: WorkerVitals): { text: string; warn: boolean } | null {
  const parts: string[] = [];
  const lag = vitals.eventLoopLagP99Ms;
  if (typeof lag === "number") parts.push(`event loop p99 ${lag} ms since boot`);
  if (typeof vitals.slowQueries === "number") parts.push(`${vitals.slowQueries} ${vitals.slowQueries === 1 ? "query" : "queries"} of 250 ms or longer since boot`);
  if (vitals.db) parts.push(`database pool ${vitals.db.total} open, ${vitals.db.idle} idle, ${vitals.db.waiting} waiting`);
  if (!parts.length) return null;
  const text = parts.join("; ");
  return { text: text[0]!.toUpperCase() + text.slice(1) + ".", warn: (typeof lag === "number" && lag >= EVENT_LOOP_WARN_MS) || (vitals.db?.waiting ?? 0) > 0 };
}

/** "184 of 258 MB heap, 71%" — the reading the incident had nowhere to appear. */
export function heapSummary(vitals: WorkerVitals): string {
  return `${vitals.heapUsedMb} of ${vitals.heapLimitMb} MB heap, ${Math.round(vitals.heapFraction * 100)}%`;
}
