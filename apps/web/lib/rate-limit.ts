/**
 * In-memory login rate limiter (single-process; resets on cold start, which is fine for a
 * single-user tool). 5 failures within 15 minutes locks out further attempts.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

let failureTimestamps: number[] = [];

function prune(now: number): void {
  failureTimestamps = failureTimestamps.filter((t) => now - t < WINDOW_MS);
}

export function isLoginRateLimited(now: number = Date.now()): boolean {
  prune(now);
  return failureTimestamps.length >= MAX_FAILURES;
}

export function recordLoginFailure(now: number = Date.now()): void {
  prune(now);
  failureTimestamps.push(now);
}

export function resetLoginFailures(): void {
  failureTimestamps = [];
}
