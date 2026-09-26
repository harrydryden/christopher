/**
 * How many model streams this process has open, and when it may open more.
 *
 * Every CV build, library review and scan calls the provider on its own, and each of them used to
 * retry a rate limit or an overload on its own schedule. A 429 or 529 therefore met every build at
 * once, and every build waited the same back-off and tried again at the same moment, which is the
 * lock-step that turns one throttle into a second. The governor is shared by every engine in the
 * process: it caps the streams open per model, lets interactive work (a person waiting on a CV)
 * through ahead of background work (a scan), and after a throttle holds every new request behind
 * one shared pause — as long as the provider's `retry-after` asks, and longer each time the
 * throttling repeats — released with jitter so the queue does not arrive together again.
 */
import type { PromptPriority } from "./prompt-registry";

/** Streams per model when `AI_MAX_STREAMS` is unset. */
export const DEFAULT_MAX_STREAMS = 24;
/** The first pause after a throttle, doubled for each throttle after it until a call succeeds. */
export const BASE_PAUSE_MS = 1_000;
/** The most a waiter's release is spread past the end of a pause. */
export const MAX_PAUSE_JITTER_MS = 2_000;
/**
 * The longest one pause may last, whatever the provider asks: short enough that the pause and the
 * most jitter a waiter adds to it still fit the minute one call may spend waiting between attempts
 * (`RETRY_WAIT_BUDGET_MS` in the engine), so a throttle the call could wait out is waited out.
 */
export const MAX_PAUSE_MS = 60_000 - MAX_PAUSE_JITTER_MS;

export interface GovernorStats {
  /** Streams allowed open at once, per model. */
  cap: number;
  /** Streams open now, across every model. */
  inFlight: number;
  /** Calls waiting for a stream, across every model. */
  queued: number;
  /** When the shared pause after a throttle ends (epoch milliseconds), or null when there is none. */
  pausedUntil: number | null;
  /** The same by model, for the models that have been used. */
  models: Record<string, { inFlight: number; queued: number }>;
}

export interface GovernorOptions {
  maxStreams?: number;
  now?: () => number;
  random?: () => number;
}

interface Waiter {
  priority: PromptPriority;
  resolve: () => void;
}

/** `AI_MAX_STREAMS` as a cap, or the default when it is unset or not a positive whole number. */
export function maxStreamsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.AI_MAX_STREAMS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_STREAMS;
}

/**
 * The wait a provider's throttle asks for, from `retry-after-ms`, then `retry-after` (seconds, or
 * an HTTP date), or undefined when it names none. Headers arrive as a `Headers` or a plain record.
 */
export function retryAfterMs(headers: unknown, now = Date.now()): number | undefined {
  const get = (name: string): string | null | undefined => {
    if (!headers || typeof headers !== "object") return undefined;
    if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
    const value = (headers as Record<string, unknown>)[name];
    return typeof value === "string" ? value : undefined;
  };
  const ms = Number.parseFloat(get("retry-after-ms") ?? "");
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const raw = get("retry-after");
  if (!raw) return undefined;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function abortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, Math.max(0, ms));
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class AiGovernor {
  readonly cap: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly open = new Map<string, number>();
  private readonly waiting = new Map<string, Waiter[]>();
  private pauseEnds = 0;
  private pauseLength = 0;
  private throttles = 0;

  constructor(options: GovernorOptions = {}) {
    this.cap = Math.max(1, Math.floor(options.maxStreams ?? maxStreamsFromEnv()));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /**
   * Wait for a stream to `model`, then hold it until the returned function is called. Waits out
   * any shared pause first. Interactive callers are let through before background ones, and each
   * class in the order it arrived. Rejects with the signal's reason if it aborts while waiting.
   */
  async acquire(model: string, priority: PromptPriority = "background", signal?: AbortSignal): Promise<() => void> {
    await this.waitForPause(signal);
    if ((this.open.get(model) ?? 0) < this.cap && !(this.waiting.get(model)?.length)) return this.take(model);
    await new Promise<void>((resolve, reject) => {
      const queue = this.waiting.get(model) ?? [];
      this.waiting.set(model, queue);
      const waiter: Waiter = { priority, resolve: () => { signal?.removeEventListener("abort", onAbort); resolve(); } };
      // Interactive work goes ahead of every background waiter, behind the interactive ones already queued.
      const at = priority === "interactive" ? queue.findIndex(item => item.priority !== "interactive") : -1;
      if (at === -1) queue.push(waiter); else queue.splice(at, 0, waiter);
      const onAbort = () => {
        const index = queue.indexOf(waiter);
        if (index !== -1) queue.splice(index, 1);
        reject(signal!.reason);
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // The releasing stream handed its place straight to this waiter.
    return this.release(model);
  }

  private take(model: string): () => void {
    this.open.set(model, (this.open.get(model) ?? 0) + 1);
    return this.release(model);
  }

  /** A release that works once: the place goes to the next waiter, or back to the pool. */
  private release(model: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.get(model)?.shift();
      if (next) next.resolve(); // The place passes on without being counted free in between.
      else this.open.set(model, Math.max(0, (this.open.get(model) ?? 1) - 1));
    };
  }

  /**
   * A throttle was met. Every request not yet sent waits until the shared pause ends: at least
   * what the provider asked for, and at least a base that doubles with each throttle in a row.
   * Throttles met while a pause is already running are one throttle, not several: a burst of
   * calls sent together meets its 429s together, and counting each would double the pause once
   * per call. Returns the pause, in milliseconds from now.
   */
  noteThrottled(askedMs?: number): number {
    if (this.now() >= this.pauseEnds) this.throttles += 1;
    const base = Math.min(MAX_PAUSE_MS, BASE_PAUSE_MS * 2 ** (this.throttles - 1));
    const pause = Math.min(MAX_PAUSE_MS, Math.max(base, askedMs ?? 0));
    const ends = this.now() + pause;
    if (ends > this.pauseEnds) {
      this.pauseEnds = ends;
      this.pauseLength = pause;
    }
    return Math.max(0, this.pauseEnds - this.now());
  }

  /** How long the shared pause has left, with the most jitter a waiter may add to it. */
  pauseLeftMs(): number {
    const left = this.pauseEnds - this.now();
    return left > 0 ? left + Math.min(MAX_PAUSE_JITTER_MS, this.pauseLength / 4) : 0;
  }

  /** A call was answered: the next throttle starts from the base pause again. */
  noteSuccess(): void {
    this.throttles = 0;
  }

  /**
   * Wait until the shared pause is over, plus this caller's own jitter — up to a quarter of the
   * pause, and at most two seconds — so the waiters do not all resume in the same millisecond.
   */
  async waitForPause(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const left = this.pauseEnds - this.now();
      if (left <= 0) return;
      const jitter = this.random() * Math.min(MAX_PAUSE_JITTER_MS, this.pauseLength / 4);
      const ends = this.pauseEnds;
      await abortable(left + jitter, signal);
      // A throttle met while this caller slept extends the pause; wait that out too.
      if (this.pauseEnds <= ends) return;
    }
  }

  stats(): GovernorStats {
    const models: GovernorStats["models"] = {};
    let inFlight = 0, queued = 0;
    for (const model of new Set([...this.open.keys(), ...this.waiting.keys()])) {
      const entry = { inFlight: this.open.get(model) ?? 0, queued: this.waiting.get(model)?.length ?? 0 };
      models[model] = entry;
      inFlight += entry.inFlight;
      queued += entry.queued;
    }
    return { cap: this.cap, inFlight, queued, pausedUntil: this.pauseEnds > this.now() ? this.pauseEnds : null, models };
  }
}

let processGovernor: AiGovernor | undefined;

/** The governor every engine in this process shares when it built its own client. */
export function defaultGovernor(): AiGovernor {
  processGovernor ??= new AiGovernor();
  return processGovernor;
}

/** This process's stream cap and what is open under it, for Health. */
export function aiGovernorStats(): GovernorStats {
  return defaultGovernor().stats();
}
