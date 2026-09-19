/**
 * The scan timing line beside Rescan: when the last scan ran, when the next is due, and whether a
 * manual rescan was reused because a scan made in the last half hour already answered it. The
 * window is the worker's own `MANUAL_RESCAN_INTERVAL_MS`, read from core so the two cannot drift.
 */
import { MANUAL_RESCAN_INTERVAL_MS } from "@christopher/core";
import type { CompanyScanTiming } from "@/lib/queries/companies";
import { relativeTime } from "@/lib/format";

/** The shared schedule, as a clause: the catalogue is scanned once a day for every follower. */
export function nextScanSentence(scanTime: string, timezone: string): string {
  return `next scheduled scan at ${scanTime} ${timezone}`;
}

export function scanTimingLine(
  timing: CompanyScanTiming,
  scanTime: string,
  timezone: string,
  now: Date = new Date(),
): string {
  const { lastGoodScanAt, rescanSkippedAt } = timing;
  // A skip is only worth reporting while it is still the answer: the reused scan is the one that
  // is still fresh, and a rescan pressed now would be served from it too.
  const reused =
    !!lastGoodScanAt &&
    !!rescanSkippedAt &&
    rescanSkippedAt.getTime() >= lastGoodScanAt.getTime() &&
    now.getTime() - lastGoodScanAt.getTime() < MANUAL_RESCAN_INTERVAL_MS;
  if (reused) return `Rescan skipped: scanned ${relativeTime(lastGoodScanAt, now)}; a scan made in the last half hour is reused.`;
  if (lastGoodScanAt) return `Scanned ${relativeTime(lastGoodScanAt, now)} · ${nextScanSentence(scanTime, timezone)}`;
  return `Not scanned yet · ${nextScanSentence(scanTime, timezone)}`;
}
