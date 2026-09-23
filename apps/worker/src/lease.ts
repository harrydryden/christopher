import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@ava/db";
import type { InterruptedError } from "@ava/core/cv-build-failure";
import type { WorkerDeps } from "./context";
import { log } from "./log";

/**
 * Someone else is already doing this. The name reaches the task row, where `failTask` writes
 * `name: message`, so the queue's own bounce is recognisable as one rather than reading as a fault.
 */
export class LeaseBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseBusyError";
  }
}

/**
 * This process no longer holds the place it was working under: the resource lease went to another
 * worker, or the task row was reclaimed.
 *
 * Both used to be plain `Error`s, told apart by the end of their message, which meant a rewording
 * silently turned "this build lost its place" into "unknown failure — ask the person". `interrupted`
 * is the mark core's taxonomy recognises, so nothing has to import the worker to name it.
 */
export class LeaseLostError extends Error implements InterruptedError {
  readonly interrupted = true as const;
  constructor(message: string) {
    super(message);
    this.name = "LeaseLostError";
  }
}

/** How long one renewal may take before the latch is cleared and the next tick tries again. */
export const LEASE_RENEWAL_TIMEOUT_MS = 10_000;
const LEASE_RENEWAL_MS = 30_000;

export interface ResourceLeaseOptions {
  /**
   * What the person is told when someone else holds the lease. The default names the key, which is
   * the queue's own vocabulary; a resource a person is watching says it in theirs.
   */
  busyMessage?: string;
  /** How often to renew, as the queue's heartbeat interval is: tests use a short one. */
  renewEveryMs?: number;
  /**
   * Called when a renewal finds the lease is no longer ours. Everything this run does from here is
   * stale, so the caller stops it rather than spending money on writes the fence will refuse.
   */
  onLost?: (error: LeaseLostError) => void;
}

/**
 * The deps a handler is given for one run: the worker's own, plus the run's signal. It aborts when
 * the queue gives up on the run — its deadline passed, or the task was taken by another worker —
 * and everything that holds something on the run's behalf lets go when it does.
 */
export type RunDeps = WorkerDeps & { signal?: AbortSignal };

/** Resolves after `ms` without holding the process open. */
function after(ms: number): Promise<void> {
  return new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
}

/**
 * Short renewable database lease, with a fencing check in every result transaction.
 *
 * A run the queue has given up on stops renewing at once, so the lease runs out within its five
 * minutes instead of being kept alive by a handler nobody is waiting for — the retry used to be
 * refused as busy for as long as the abandoned run lived — and the fence refuses its writes from
 * that moment, not only once the lease has gone to someone else.
 */
export async function withResourceLease<T>(
  deps: RunDeps,
  key: string,
  work: (deps: WorkerDeps) => Promise<T>,
  options: ResourceLeaseOptions = {},
): Promise<T> {
  const signal = deps.signal;
  if (signal?.aborted) throw new LeaseLostError(`Run was stopped before it took its lease: ${key}`);
  const owner = randomUUID();
  const claimed = await deps.db.execute(sql`insert into resource_leases (key, owner, expires_at)
    values (${key}, ${owner}, now() + interval '5 minutes')
    on conflict (key) do update set owner = excluded.owner, expires_at = excluded.expires_at
    where resource_leases.expires_at < now() returning key`);
  if (!claimed.rows.length) throw new LeaseBusyError(options.busyMessage ?? `Operation already running: ${key}`);
  const renewEveryMs = options.renewEveryMs ?? LEASE_RENEWAL_MS;
  let renewal: Promise<unknown> = Promise.resolve();
  let renewing = false;
  const renewOnce = async () => {
    const rows = await deps.db.execute(sql`update resource_leases set expires_at = now() + interval '5 minutes'
      where key = ${key} and owner = ${owner} returning key`);
    if (rows.rows.length || signal?.aborted) return;
    log.warn("operation lease lost", { key });
    options.onLost?.(new LeaseLostError(`Operation lease lost; refusing stale writes: ${key}`));
  };
  const timer = setInterval(() => {
    if (renewing || signal?.aborted) return;
    renewing = true;
    // A renewal that never settles used to latch renewal off for good: the lease then expired
    // under work that was still running, another worker claimed it, and two processes wrote for
    // the same thing. The latch is timed, so one hung query costs one renewal rather than all of
    // them, and the query itself is left to settle in its own time.
    renewal = renewOnce().catch(error => log.warn("operation lease renewal failed", { key, error: (error as Error).message }));
    void Promise.race([renewal, after(Math.min(renewEveryMs, LEASE_RENEWAL_TIMEOUT_MS))]).finally(() => { renewing = false; });
  }, renewEveryMs);
  timer.unref();
  const stopRenewing = () => clearInterval(timer);
  signal?.addEventListener("abort", stopRenewing, { once: true });
  try {
    return await work({ ...deps, assertOwnership: async (db: Db) => {
      await deps.assertOwnership?.(db);
      if (signal?.aborted) throw new LeaseLostError("Run was stopped; refusing its writes");
      const rows = await db.execute(sql`select key from resource_leases where key = ${key} and owner = ${owner} and expires_at > now() for update`);
      if (!rows.rows.length) throw new LeaseLostError("Operation lease lost; refusing stale writes");
    } });
  } finally {
    signal?.removeEventListener("abort", stopRenewing);
    clearInterval(timer);
    await renewal.catch(() => undefined);
    await deps.db.execute(sql`delete from resource_leases where key = ${key} and owner = ${owner}`);
  }
}
