import { scanRunSummaries, type ScanRunSummary } from "@ava/db";
import type { ScanRun } from "@ava/db/schema";
import { db } from "./db";

/**
 * The banner is read on every server render and again every 30 seconds in every open tab, and the
 * numbers only move when a scan finishes, so one account's summary of one run is held briefly
 * rather than recomputed per render. Nothing but counts is cached, and a stale count is at most
 * half a minute old.
 */
const TTL_MS = 30_000;
const MAX_ENTRIES = 200;
const cache = new Map<string, { at: number; summary: ScanRunSummary }>();

const keyFor = (runId: string, userId?: string) => `${runId}|${userId ?? ""}`;

function remember(runId: string, userId: string | undefined, summary: ScanRunSummary, now: number): void {
  if (cache.size >= MAX_ENTRIES) {
    for (const [key, entry] of cache) if (now - entry.at >= TTL_MS) cache.delete(key);
    if (cache.size >= MAX_ENTRIES) cache.clear();
  }
  cache.set(keyFor(runId, userId), { at: now, summary });
}

/** Tests and anything that has just written a scan result read through to the database again. */
export function clearScanSummaryCache(): void {
  cache.clear();
}

function report(run: ScanRun, summary: ScanRunSummary, userId?: string) {
  const historicalOnly = !summary.sources && !!run.finishedAt && run.companiesTotal > 0 && !userId;
  if (historicalOnly) return { ...run, historicalOnly };
  const total = userId ? summary.sources + summary.pending : run.companiesTotal;
  const companiesOk = Math.min(total, summary.companies_ok);
  return {
    ...run, historicalOnly,
    companiesTotal: total,
    companiesOk,
    companiesFailed: run.finishedAt ? Math.max(0, total - companiesOk) : 0,
    newRoles: summary.new_roles,
    closedRoles: summary.closed_roles,
  };
}

/** A run is shared; with a `userId` the counts cover only the companies that account follows. */
export async function scanRunReport(run: ScanRun, userId?: string) {
  const now = Date.now();
  const cached = cache.get(keyFor(run.id, userId));
  if (cached && now - cached.at < TTL_MS) return report(run, cached.summary, userId);
  const summary = (await scanRunSummaries(db(), [run.id], userId)).get(run.id)!;
  remember(run.id, userId, summary, now);
  return report(run, summary, userId);
}

/** Several runs (Health's history) in one query rather than one query per run. */
export async function scanRunReports(runs: ScanRun[], userId?: string) {
  if (!runs.length) return [];
  const summaries = await scanRunSummaries(db(), runs.map((run) => run.id), userId);
  const now = Date.now();
  return runs.map((run) => {
    const summary = summaries.get(run.id)!;
    remember(run.id, userId, summary, now);
    return report(run, summary, userId);
  });
}
