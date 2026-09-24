import { describe, expect, it } from "vitest";
import {
  BANNER_FIRST_MS,
  FIRST_POLL_MS,
  LONGEST_POLL_MS,
  REFRESH_RETRIES,
  SETTLED_REFRESHES,
  bannerPollDelay,
  failedWorkPoll,
  initialWorkPoll,
  nextPollDelay,
  stepWorkPoll,
  type WorkPollState,
  type WorkReading,
} from "./polling";

/** Feed readings through the poller as the component does, counting refreshes and recording waits. */
function run(initialVersion: string | undefined, readings: WorkReading[]) {
  let state: WorkPollState = initialWorkPoll(initialVersion);
  let refreshes = 0;
  let reloads = 0;
  const waits: Array<number | null> = [];
  for (const reading of readings) {
    const step = stepWorkPoll(state, reading);
    state = step.state;
    if (step.refresh) refreshes++;
    if (step.reload) reloads++;
    waits.push(step.next);
    if (step.next === null) break;
  }
  return { refreshes, reloads, waits, state };
}

const active = (version: string): WorkReading => ({ active: true, version });

describe("nextPollDelay", () => {
  it("grows by half from ten seconds to a minute while nothing changes, and resets on a change", () => {
    const waits = [FIRST_POLL_MS];
    for (let i = 0; i < 6; i++) waits.push(nextPollDelay(waits.at(-1)!, false));
    expect(waits).toEqual([10_000, 15_000, 22_500, 33_750, 50_625, 60_000, 60_000]);
    expect(nextPollDelay(LONGEST_POLL_MS, true)).toBe(FIRST_POLL_MS);
    expect(nextPollDelay(45_000, true, BANNER_FIRST_MS)).toBe(BANNER_FIRST_MS);
  });
});

describe("stepWorkPoll", () => {
  it("refreshes a page that rendered no version once per change, not on every later tick", () => {
    // The first reading is the baseline; the second changed; the rest repeat the change. Comparing
    // every reading with the baseline refreshed the page on each of them for as long as work ran.
    const { refreshes } = run(undefined, [active("v1"), active("v2"), active("v2"), active("v2"), active("v2")]);
    expect(refreshes).toBe(1);
  });

  it("refreshes once for each distinct change", () => {
    expect(run(undefined, [active("v1"), active("v2"), active("v2"), active("v3"), active("v3"), active("v4")]).refreshes).toBe(3);
  });

  it("compares a page's rendered version with the first reading", () => {
    expect(run("v1", [active("v1"), active("v1")]).refreshes).toBe(0);
    expect(run("v1", [active("v2")]).refreshes).toBe(1);
  });

  it("asks again, soon, while a rendered page has not shown the version it was refreshed for", () => {
    // A refresh is a request that can be lost. The page acknowledges one by rendering again with
    // the new version, which starts the poller afresh; until then the poller asks again at the
    // first interval, a bounded number of times, rather than leaving a finished stage on screen.
    const { refreshes, waits } = run("v1", [active("v2"), active("v2"), active("v2"), active("v2"), active("v2")]);
    expect(refreshes).toBe(1 + REFRESH_RETRIES);
    expect(waits.slice(0, 1 + REFRESH_RETRIES)).toEqual([FIRST_POLL_MS, FIRST_POLL_MS, FIRST_POLL_MS]);
  });

  it("does not loop when the page keeps rendering a version the poll never returns", () => {
    // A page whose rendered version differs from the poll's (a different scope, say) is refreshed
    // for it a bounded number of times, and then compared with what it was refreshed for.
    expect(run("page-version", Array.from({ length: 20 }, () => active("poll-version"))).refreshes).toBe(1 + REFRESH_RETRIES);
  });

  it("backs off while nothing changes and returns to ten seconds after a change", () => {
    const { waits } = run("v1", [active("v1"), active("v1"), active("v1"), active("v2"), active("v2")]);
    // The last reading repeats a version the page has not shown, so it is asked for again, soon.
    expect(waits).toEqual([15_000, 22_500, 33_750, FIRST_POLL_MS, FIRST_POLL_MS]);
  });

  it("loses no time over one failed reading, and backs off only when readings keep failing", () => {
    // The reading a dropped request stood for may be the change the page is waiting on, so the
    // next one comes as soon as it would have anyway; a run of failures is the server saying no.
    let state = initialWorkPoll("v1");
    let failed = failedWorkPoll(state);
    expect(failed.next).toBe(FIRST_POLL_MS);
    failed = failedWorkPoll(failed.state);
    expect(failed.next).toBe(15_000);
    failed = failedWorkPoll(failed.state);
    expect(failed.next).toBe(22_500);
    // A reading that arrives ends the run of failures, whatever it says.
    state = stepWorkPoll(failed.state, active("v1")).state;
    expect(state.failures).toBe(0);
    expect(failedWorkPoll(state).next).toBe(state.wait);
  });

  it("reloads when finished work remains unrendered after two soft refreshes", () => {
    const finished = { active: false, version: "" };
    const { refreshes, reloads, waits } = run("v1", Array.from({ length: 10 }, () => finished));
    expect(refreshes).toBe(SETTLED_REFRESHES - 1);
    expect(reloads).toBe(1);
    expect(waits).toHaveLength(SETTLED_REFRESHES);
    expect(waits.at(-1)).toBeNull();
    // Each refresh of finished work comes at the first interval: a lost one is retried in ten
    // seconds, not after a back-off that would leave a finished build on its progress screen.
    expect(waits.slice(0, -1).every((wait) => wait === FIRST_POLL_MS)).toBe(true);
  });

  it("starts counting settled refreshes again when new work appears", () => {
    const finished = { active: false, version: "" };
    const { refreshes, reloads, waits } = run("v1", [finished, finished, active("v2"), finished, finished, finished]);
    // Two soft refreshes, the refresh for new work, then two more and a document reload.
    expect(refreshes).toBe(5);
    expect(reloads).toBe(1);
    expect(waits.at(-1)).toBeNull();
  });
});

describe("bannerPollDelay", () => {
  it("polls at the current wait while live, sleeps until the hint's wake-up, and otherwise stops", () => {
    expect(bannerPollDelay({ live: true, wakeInMs: null }, 45_000)).toBe(45_000);
    expect(bannerPollDelay({ live: false, wakeInMs: 3_600_000 }, 45_000)).toBe(3_600_000);
    expect(bannerPollDelay({ live: false, wakeInMs: -5 }, 45_000)).toBe(0);
    expect(bannerPollDelay({ live: false, wakeInMs: 40 * 86_400_000 }, 45_000)).toBe(86_400_000);
    expect(bannerPollDelay({ live: false, wakeInMs: null }, 45_000)).toBeNull();
  });
});
