import { expect, it } from "vitest";
import { MANUAL_RESCAN_INTERVAL_MS } from "@ava/core";
import { nextScanSentence, scanTimingLine } from "./scan-line";

const NOW = new Date("2026-09-19T10:00:00Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

it("says when the next scan is due, whether or not this company has ever been scanned", () => {
  expect(nextScanSentence("06:00", "Europe/London")).toBe("next scheduled scan at 06:00 Europe/London");
  expect(scanTimingLine({ lastGoodScanAt: null, rescanSkippedAt: null }, "06:00", "Europe/London", NOW))
    .toBe("Not scanned yet · next scheduled scan at 06:00 Europe/London");
  expect(scanTimingLine({ lastGoodScanAt: minutesAgo(90), rescanSkippedAt: null }, "23:30", "UTC", NOW))
    .toBe("Scanned 2h ago · next scheduled scan at 23:30 UTC");
});

it("says a rescan was skipped only while a rescan would still be served from that scan", () => {
  const scanned = minutesAgo(12);
  expect(scanTimingLine({ lastGoodScanAt: scanned, rescanSkippedAt: minutesAgo(1) }, "06:00", "Europe/London", NOW))
    .toBe("Rescan skipped: scanned 12m ago; a scan made in the last half hour is reused.");

  // Past the reuse window the skip is history: pressing Rescan now would really run one.
  const stale = new Date(NOW.getTime() - MANUAL_RESCAN_INTERVAL_MS - 60_000);
  expect(scanTimingLine({ lastGoodScanAt: stale, rescanSkippedAt: minutesAgo(20) }, "06:00", "Europe/London", NOW))
    .toBe("Scanned 31m ago · next scheduled scan at 06:00 Europe/London");

  // A skip recorded before the scan in hand belongs to an older scan, not this one.
  expect(scanTimingLine({ lastGoodScanAt: minutesAgo(5), rescanSkippedAt: minutesAgo(40) }, "06:00", "Europe/London", NOW))
    .toBe("Scanned 5m ago · next scheduled scan at 06:00 Europe/London");

  // A skip with nothing to have been served from says nothing about a skip.
  expect(scanTimingLine({ lastGoodScanAt: null, rescanSkippedAt: minutesAgo(1) }, "06:00", "Europe/London", NOW))
    .toBe("Not scanned yet · next scheduled scan at 06:00 Europe/London");
});
