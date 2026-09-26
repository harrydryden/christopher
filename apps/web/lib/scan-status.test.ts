import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  latest: null as null | Record<string, unknown>,
}));
vi.mock("./settings", () => ({ getSystemSettings: vi.fn(async () => ({ scanTime: "06:00", timezone: "Europe/London" })) }));
vi.mock("./queries/scan-strip", () => ({
  scanStripFacts: vi.fn(async (userId: string) => ({
    lastScanAt: userId === "scanned" ? new Date("2026-09-11T04:30:00Z") : null,
    following: userId === "scanned" ? 6 : 0,
    newRoleMatches: userId === "scanned" ? 3 : 0,
    newCompanyMatches: userId === "scanned" ? 2 : 0,
    latestRun: mocks.latest,
  })),
}));

import { getScanStatus, scanPollHint } from "./scan-status";

const schedule = { scanTime: "06:00", timezone: "Europe/London" };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// 06:00 in London on these dates is 05:00 UTC.
const due = new Date("2026-09-11T05:00:00Z");
const at = (offsetMs: number) => new Date(due.getTime() + offsetMs);
const finishedRun = (startedAt: Date) => ({ startedAt, finishedAt: new Date(startedAt.getTime() + 30 * MINUTE) });

describe("scanPollHint", () => {
  it("is live while a run is in progress, whatever the time", () => {
    expect(scanPollHint({ startedAt: at(-3 * HOUR), finishedAt: null }, schedule, at(5 * HOUR))).toEqual({ live: true, wakeInMs: null });
  });

  it("is live from an hour before the scheduled time until the run starts", () => {
    const yesterday = finishedRun(at(-24 * HOUR));
    expect(scanPollHint(yesterday, schedule, at(-59 * MINUTE))).toEqual({ live: true, wakeInMs: null });
    expect(scanPollHint(yesterday, schedule, at(0))).toEqual({ live: true, wakeInMs: null });
    // Overdue by minutes: the scheduler is about to start it.
    expect(scanPollHint(yesterday, schedule, at(30 * MINUTE))).toEqual({ live: true, wakeInMs: null });
  });

  it("stops polling once today's run has finished and sleeps until the day or the schedule next turns", () => {
    const today = finishedRun(at(0));
    // 06:40 London: tomorrow's run is 23h20m away, midnight 17h20m away, and midnight comes first.
    expect(scanPollHint(today, schedule, at(40 * MINUTE))).toEqual({ live: false, wakeInMs: 17 * HOUR + 20 * MINUTE });
  });

  it("wakes just after midnight when the finished run started today, so 'Today' stays true", () => {
    const today = finishedRun(at(0));
    // 12:00 London; midnight is 12 hours away and the next run's hour 17 hours away.
    expect(scanPollHint(today, schedule, at(6 * HOUR))).toEqual({ live: false, wakeInMs: 12 * HOUR });
    // 00:10 London the next day: the run no longer started today, so it wakes for the next run.
    expect(scanPollHint(today, schedule, at(18 * HOUR + 10 * MINUTE))).toEqual({ live: false, wakeInMs: 4 * HOUR + 50 * MINUTE });
  });

  it("stops watching a run an hour overdue and waits for tomorrow's", () => {
    const yesterday = finishedRun(at(-24 * HOUR));
    // 08:00 London with nothing started today: no worker is running, and asking will not start one.
    expect(scanPollHint(yesterday, schedule, at(2 * HOUR))).toEqual({ live: false, wakeInMs: 21 * HOUR });
  });

  it("treats a manual run earlier in the day as not today's scheduled run", () => {
    const manual = finishedRun(at(-3 * HOUR));
    expect(scanPollHint(manual, schedule, at(-30 * MINUTE))).toEqual({ live: true, wakeInMs: null });
  });

  it("is live an hour before a run due just after midnight", () => {
    const early = { scanTime: "00:10", timezone: "Europe/London" };
    // 23:30 London, today's 00:10 run finished long ago: tomorrow's is forty minutes away.
    const ranAtTen = finishedRun(new Date("2026-09-10T23:10:00Z"));
    expect(scanPollHint(ranAtTen, early, new Date("2026-09-11T22:30:00Z"))).toEqual({ live: true, wakeInMs: null });
  });

  it("with no run yet, waits for the first scheduled one", () => {
    expect(scanPollHint(null, schedule, at(-3 * HOUR))).toEqual({ live: false, wakeInMs: 2 * HOUR });
  });

  it("counts the seconds into the current minute", () => {
    expect(scanPollHint(null, schedule, at(-3 * HOUR + 15_000))).toEqual({ live: false, wakeInMs: 2 * HOUR - 15_000 });
  });
});

describe("getScanStatus", () => {
  beforeEach(() => { mocks.latest = null; });

  it("says the four facts and when the banner should ask again", async () => {
    expect(await getScanStatus("user", at(-3 * HOUR))).toEqual({
      scanning: false, lastScanAt: null, following: 0, newRoleMatches: 0, newCompanyMatches: 0, live: false, wakeInMs: 2 * HOUR,
    });
    // New role matches are the Matched tab's count alone: shortlisted and dismissed roles are decided.
    expect(await getScanStatus("scanned", at(-3 * HOUR))).toMatchObject({
      lastScanAt: "2026-09-11T04:30:00.000Z", following: 6, newRoleMatches: 3, newCompanyMatches: 2,
    });
  });

  it("is scanning while the shared run is in progress", async () => {
    mocks.latest = { startedAt: at(0), finishedAt: null, trigger: "schedule" };
    const status = await getScanStatus("user", at(10 * MINUTE));
    expect(status).toMatchObject({ scanning: true, live: true });
    mocks.latest = { startedAt: at(0), finishedAt: at(30 * MINUTE), trigger: "schedule" };
    expect((await getScanStatus("user", at(40 * MINUTE))).scanning).toBe(false);
  });
});
