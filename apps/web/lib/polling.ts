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
   * The version the page on screen accounts for: the one it rendered, or, for a page that rendered
   * none, the first reading. Undefined only until that first reading.
   */
  seen: string | undefined;
  /**
   * Whether the page said what it rendered. Such a page acknowledges a refresh by rendering again
   * with the new version, which resets this state; one that rendered nothing cannot, so it is
   * refreshed once per change and believed.
   */
  rendered: boolean;
  /** The version a rendered page was last refreshed for and has not shown yet. */
  requested: string | undefined;
  /** Refreshes asked for that same version since, bounded by `REFRESH_RETRIES`. */
  retries: number;
  wait: number;
  /** Refreshes asked for since the work was last seen finished. */
  settled: number;
  /** Readings in a row that failed to arrive; the first costs no wait, the rest back off. */
  failures: number;
}

/**
 * How many times finished work is acted on while this poller remains mounted. Two soft refreshes
 * normally render the completed page without it; the last reading falls back to a document reload
 * if neither refresh landed.
 */
export const SETTLED_REFRESHES = 3;

/**
 * How many more times a rendered page is refreshed for a version it has not shown. A refresh is a
 * request that can be lost like any other, and a page left showing a stage the build has finished
 * is the failure a poller exists to prevent; a page whose rendered version simply never matches the
 * poll's (a different scope, say) is refreshed this many times and then compared with the poll's.
 */
export const REFRESH_RETRIES = 2;

export function initialWorkPoll(initialVersion?: string): WorkPollState {
  return { seen: initialVersion, rendered: initialVersion !== undefined, requested: undefined, retries: 0, wait: FIRST_POLL_MS, settled: 0, failures: 0 };
}

/**
 * A reading that did not arrive (a refused or dropped request). It is not news, so nothing is
 * refreshed; one lost request costs no time either, because the reading it stood for may be the
 * change the page is waiting on, and only a run of failures backs the poller off.
 */
export function failedWorkPoll(state: WorkPollState): { state: WorkPollState; next: number } {
  const failures = state.failures + 1;
  const wait = failures > 1 ? nextPollDelay(state.wait, false) : state.wait;
  return { state: { ...state, failures, wait }, next: wait };
}

/**
 * One reading of the work a page watches: whether to refresh the page, and how long to wait before
 * the next reading (`null` to stop).
 *
 * A changed version refreshes the page. A page that rendered its version shows the new one once the
 * refresh lands, which starts this state afresh; until it does, the next readings ask again, a
 * bounded number of times. A page that rendered no version is refreshed once per change and the
 * change is then counted as seen, so it is refreshed once per change rather than on every tick.
 */
export function stepWorkPoll(previous: WorkPollState, reading: WorkReading): { state: WorkPollState; refresh: boolean; reload: boolean; next: number | null } {
  const state: WorkPollState = previous.failures ? { ...previous, failures: 0 } : previous;
  if (!reading.active) {
    // A finished build the page has not shown is the failure a poller exists to prevent, so the
    // few attempts for finished work come at the first interval, not a backed-off one.
    const settled = state.settled + 1;
    // A dropped RSC response can leave Next's soft refresh stuck in flight. If the old poller is
    // still mounted after two soft refreshes, a document reload recovers the finished page.
    return { state: { ...state, seen: reading.version, requested: undefined, retries: 0, wait: FIRST_POLL_MS, settled }, refresh: settled < SETTLED_REFRESHES, reload: settled === SETTLED_REFRESHES, next: settled < SETTLED_REFRESHES ? FIRST_POLL_MS : null };
  }
  if (state.seen === undefined) {
    // The baseline for a page that rendered nothing: its later readings are compared with this.
    const wait = nextPollDelay(state.wait, false);
    return { state: { ...state, seen: reading.version, wait, settled: 0 }, refresh: false, reload: false, next: wait };
  }
  if (state.seen === reading.version) {
    const wait = nextPollDelay(state.wait, false);
    return { state: { ...state, requested: undefined, retries: 0, wait, settled: 0 }, refresh: false, reload: false, next: wait };
  }
  if (!state.rendered) {
    return { state: { ...state, seen: reading.version, wait: FIRST_POLL_MS, settled: 0 }, refresh: true, reload: false, next: FIRST_POLL_MS };
  }
  if (state.requested !== reading.version) {
    return { state: { ...state, requested: reading.version, retries: 0, wait: FIRST_POLL_MS, settled: 0 }, refresh: true, reload: false, next: FIRST_POLL_MS };
  }
  if (state.retries < REFRESH_RETRIES) {
    return { state: { ...state, retries: state.retries + 1, wait: FIRST_POLL_MS, settled: 0 }, refresh: true, reload: false, next: FIRST_POLL_MS };
  }
  // The page never shows this version: stop asking for it, and compare with it from now on.
  const wait = nextPollDelay(state.wait, false);
  return { state: { ...state, seen: reading.version, requested: undefined, retries: 0, wait, settled: 0 }, refresh: false, reload: false, next: wait };
}

/**
 * The CV page's progress feed backs off no further than this. A reading of it is one query that
 * returns only what moved, so it can afford to ask more often than a page re-render could, and a
 * build's motions open and close every few seconds to a few minutes.
 */
export const PROGRESS_LONGEST_MS = 30_000;

/**
 * One reading of the CV page's progress feed. The version decides server renders exactly as
 * `stepWorkPoll` does — including the finished build's soft refreshes and the document reload that
 * recovers a refresh that never landed — and `stepsChanged` (the feed brought rows the page did not
 * have) only brings the next reading forward, because the page renders those rows itself.
 */
export function stepProgressPoll(
  previous: WorkPollState,
  reading: WorkReading,
  stepsChanged: boolean,
): { state: WorkPollState; refresh: boolean; reload: boolean; next: number | null } {
  const step = stepWorkPoll(previous, reading);
  if (step.next === null || step.reload || !reading.active) return step;
  const wait = step.refresh || stepsChanged ? FIRST_POLL_MS : Math.min(step.next, PROGRESS_LONGEST_MS);
  return { ...step, state: { ...step.state, wait }, next: wait };
}

/**
 * The ready page's build log, which keeps reading while the improvement pass runs after the CV
 * was published: sooner when rows arrived, backing off while none do, and stopping once nothing is
 * writing to the ledger. There is no render to ask for — the log renders the rows itself.
 */
export function nextLogPoll(wait: number, live: boolean, changed: boolean): number | null {
  return live ? nextPollDelay(wait, changed, FIRST_POLL_MS, PROGRESS_LONGEST_MS) : null;
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
