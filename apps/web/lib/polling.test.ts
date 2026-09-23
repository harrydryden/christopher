import { describe, expect, it } from "vitest";
import {
  BANNER_FIRST_MS,
  FIRST_POLL_MS,
  LONGEST_POLL_MS,
  SETTLED_REFRESHES,
  bannerPollDelay,
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
  const waits: Array<number | null> = [];
  for (const reading of readings) {
    const step = stepWorkPoll(state, reading);
    state = step.state;
    if (step.refresh) refreshes++;
    waits.push(step.next);
    if (step.next === null) break;
  }
  return { refreshes, waits, state };
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
    expect(run("v1", [active("v2"), active("v2"), active("v2")]).refreshes).toBe(1);
  });

  it("does not loop when the page keeps rendering a version the poll never returns", () => {
    // A page whose rendered version differs from the poll's (a different scope, say) is refreshed
    // once, and then compared with what it was refreshed for.
    expect(run("page-version", Array.from({ length: 20 }, () => active("poll-version"))).refreshes).toBe(1);
  });

  it("backs off while nothing changes and returns to ten seconds after a change", () => {
    const { waits } = run("v1", [active("v1"), active("v1"), active("v1"), active("v2"), active("v2")]);
    expect(waits).toEqual([15_000, 22_500, 33_750, FIRST_POLL_MS, 15_000]);
  });

  it("refreshes when the work finishes and stops asking after a few unanswered refreshes", () => {
    const finished = { active: false, version: "" };
    const { refreshes, waits } = run("v1", Array.from({ length: 10 }, () => finished));
    expect(refreshes).toBe(SETTLED_REFRESHES);
    expect(waits).toHaveLength(SETTLED_REFRESHES);
    expect(waits.at(-1)).toBeNull();
    expect(waits.slice(0, -1).every((wait) => typeof wait === "number" && wait > FIRST_POLL_MS)).toBe(true);
  });

  it("starts counting settled refreshes again when new work appears", () => {
    const finished = { active: false, version: "" };
    const { refreshes, waits } = run("v1", [finished, finished, active("v2"), finished, finished, finished]);
    // Two settled refreshes, the refresh for new work, then three more settled ones before stopping.
    expect(refreshes).toBe(6);
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
