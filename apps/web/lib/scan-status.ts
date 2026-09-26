import { localDateParts, type SystemSettings } from "@ava/core";
import type { ScanRun } from "@ava/db/schema";
import { scanStripFacts } from "./queries/scan-strip";
import { getSystemSettings } from "./settings";
import type { ScanStripFacts } from "./scan-banner";
import type { ScanPollHint } from "./polling";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const minutesOf = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * When the banner in an open tab needs to ask again. Its figures move only while a run is in
 * progress, and a run starts only at the scheduled time, so it asks while one is running or due
 * within the hour and otherwise sleeps until that hour begins. A run started today also wakes it
 * just after midnight, when "Today" in its text stops being true. A manual run is rare and started
 * by an administrator: their page renders the banner again, and another reader's tab picks it up
 * when it is next looked at (`BANNER_RECHECK_MS`) or fully rendered.
 */
export function scanPollHint(run: Pick<ScanRun, "startedAt" | "finishedAt"> | null, schedule: Pick<SystemSettings, "scanTime" | "timezone">, now: Date): ScanPollHint {
  if (run && !run.finishedAt) return { live: true, wakeInMs: null };
  const today = localDateParts(now, schedule.timezone);
  // Every zone the schedule can name is offset by whole minutes, so the seconds are the same here.
  const sinceMidnight = minutesOf(today.hm) * 60_000 + (now.getTime() % 60_000);
  const started = run ? localDateParts(run.startedAt, schedule.timezone) : null;
  const ranToday = !!started && started.ymd === today.ymd && started.hm >= schedule.scanTime;
  let untilDue = minutesOf(schedule.scanTime) * 60_000 - sinceMidnight;
  // The scheduler starts a due run within a minute. Once today's has run, or an hour has passed
  // without it starting (no worker is running, and asking would not start one), watch for tomorrow's.
  if (ranToday || untilDue <= -HOUR_MS) untilDue += DAY_MS;
  if (untilDue <= HOUR_MS) return { live: true, wakeInMs: null };
  let wakeInMs = untilDue - HOUR_MS;
  if (started?.ymd === today.ymd) wakeInMs = Math.min(wakeInMs, DAY_MS - sinceMidnight);
  return { live: false, wakeInMs };
}

/** What the status strip says for one account, and when an open tab should ask again. */
export type ScanStatus = ScanStripFacts & ScanPollHint;

/**
 * The strip's four facts for one account — last completed scan of a company it follows, how many it
 * follows, roles still to review (the Matched tab's count) and pending company suggestions — plus
 * whether the shared run is in progress, and the poll hint for the tab that shows them. The facts
 * and the run are one statement; the schedule is the request's shared settings read.
 */
export async function getScanStatus(userId: string, now = new Date()): Promise<ScanStatus> {
  const [facts, settings] = await Promise.all([scanStripFacts(userId), getSystemSettings()]);
  const run = facts.latestRun;
  return {
    scanning: !!run && !run.finishedAt,
    lastScanAt: facts.lastScanAt ? facts.lastScanAt.toISOString() : null,
    following: facts.following,
    newRoleMatches: facts.newRoleMatches,
    newCompanyMatches: facts.newCompanyMatches,
    ...scanPollHint(run, settings, now),
  };
}
