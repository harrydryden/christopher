/** Timers that never hold the process open, and the bounded renewal loop the queue and leases share. */

/** Resolves after `ms`. */
export function after(ms: number): Promise<void> {
  return new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
}

/** `promise`'s value, or `fallback` if it has not settled within `ms`. Never rejects. */
export function within<T>(promise: Promise<T> | undefined, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    (promise ?? Promise.resolve(fallback)).catch(() => fallback),
    new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

/** Resolves once `work` settles or `ms` has passed, whichever is first; never rejects. */
export function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  return within(work.then(() => undefined), ms, undefined);
}

/**
 * Run `renew` every `everyMs`, one at a time, unless `skip` says not to.
 *
 * A renewal that never settled used to latch renewal off for good: a task went stale in five
 * minutes and a second attempt ran beside it, or a lease expired under running work and two
 * processes wrote for the same thing. The latch clears after `timeoutMs` (calling `onTimeout`),
 * so one hung renewal costs one beat rather than all of them; the renewal itself is left to settle
 * in its own time. `renew` handles its own errors.
 */
export function startRenewal(o: {
  everyMs: number; timeoutMs: number; renew: () => Promise<void>; skip?: () => boolean; onTimeout?: () => void;
}): { stop: () => void; settled: () => Promise<void> } {
  let renewing = false;
  let last: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    if (renewing || o.skip?.()) return;
    renewing = true;
    last = o.renew().catch(() => undefined);
    void within(last.then(() => false), o.timeoutMs, true)
      .then(timedOut => { if (timedOut) o.onTimeout?.(); })
      .finally(() => { renewing = false; });
  }, o.everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer), settled: () => last };
}
