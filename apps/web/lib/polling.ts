/**
 * The timing and version rules the pages' pollers share, kept apart from React so they can be
 * tested without a browser.
 *
 * Every open tab runs these, so they are written for a thousand tabs rather than one: a poller asks
 * again sooner only when something changed, waits longer each time nothing did, refreshes its page
 * once for each change it sees, and stops once the work it watches is finished.
 */

/** First interval, and the ceiling a poller backs off to while nothing changes. */
export const FIRST_POLL_MS = 10_000;
export const LONGEST_POLL_MS = 60_000;

/** Back to the first interval after a change; otherwise half as long again, up to the ceiling. */
export function nextPollDelay(wait: number, changed: boolean, first = FIRST_POLL_MS, longest = LONGEST_POLL_MS): number {
  return changed ? first : Math.min(longest, Math.round(wait * 1.5));
}

/** What `/api/work-status` answers. */
export interface WorkReading {
  active: boolean;
  version: string;
}

export interface WorkPollState {
  /**
   * The version the page on screen already accounts for: the one it rendered, or the last one a
   * refresh was asked for. Undefined only until the first reading of a page that gave none.
   */
  seen: string | undefined;
  wait: number;
  /** Refreshes asked for since the work was last seen finished. */
  settled: number;
}

/**
 * How many times a finished reading refreshes a page that is still showing this poller. The first
 * refresh normally renders the page without it; the others cover a refresh that did not land, and
 * then the poller stops rather than asking about finished work forever.
 */
export const SETTLED_REFRESHES = 3;

export function initialWorkPoll(initialVersion?: string): WorkPollState {
  return { seen: initialVersion, wait: FIRST_POLL_MS, settled: 0 };
}

/**
 * One reading of the work a page watches: whether to refresh the page, and how long to wait before
 * the next reading (`null` to stop).
 *
 * A changed version refreshes once and is then the version seen, whether or not the page reports
 * the new one back, so a page that renders no version, or a different one, is refreshed once per
 * change rather than on every tick.
 */
export function stepWorkPoll(state: WorkPollState, reading: WorkReading): { state: WorkPollState; refresh: boolean; next: number | null } {
  if (!reading.active) {
    const settled = state.settled + 1;
    const wait = nextPollDelay(state.wait, false);
    return { state: { seen: reading.version, wait, settled }, refresh: true, next: settled < SETTLED_REFRESHES ? wait : null };
  }
  const changed = state.seen !== undefined && state.seen !== reading.version;
  const wait = nextPollDelay(state.wait, changed);
  return { state: { seen: reading.version, wait, settled: 0 }, refresh: changed, next: wait };
}

/** The banner's cadence while a run is in progress or about to start, and what it backs off to. */
export const BANNER_FIRST_MS = 30_000;

/**
 * What `/api/scan-status` says about when the banner should next ask: `live` while a run is in
 * progress or due within the hour, and otherwise `wakeInMs` until that hour begins, or null when
 * no run is due at all.
 */
export interface ScanPollHint {
  live: boolean;
  wakeInMs: number | null;
}

/** The delay before the banner's next reading, or null to stop asking. */
export function bannerPollDelay(hint: ScanPollHint, wait: number): number | null {
  if (hint.live) return wait;
  if (hint.wakeInMs === null) return null;
  // A timer longer than a signed 32-bit millisecond count fires at once; a day is the most a
  // schedule can ask for, and the reading at the end of it says what to do next.
  return Math.min(Math.max(0, hint.wakeInMs), 86_400_000);
}

/** Consecutive failed readings after which the banner stops and leaves its "unavailable" note. */
export const BANNER_FAILURES = 5;

/**
 * Between runs, a tab that is looked at again reads a fresh line if its last is this old, so a
 * manual run an administrator started shows up when the reader returns rather than at the next
 * scheduled wake-up.
 */
export const BANNER_RECHECK_MS = 10 * 60_000;
