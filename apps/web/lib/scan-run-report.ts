import { scanRunSummaries, type ScanRunSummary } from "@ava/db";
import type { ScanRun } from "@ava/db/schema";
import { db } from "./db";

/**
 * The banner is read on every server render and again by every open tab while a run is in
 * progress, and the numbers only move when a scan finishes, so one account's summary of one run is
 * held briefly rather than recomputed per render. Nothing but counts is cached, and a stale count
 * is at most half a minute old.
 *
 * The entries are small and an instance can serve many accounts in half a minute, so the cache
 * keeps the most recently used thousand and drops the least recently used one at a time: an
 * instance busier than its bound still serves its recent accounts from memory, where emptying the
 * whole map would serve none of them.
 */
const TTL_MS = 30_000;
export const MAX_ENTRIES = 1000;
const cache = new Map<string, { at: number; summary: ScanRunSummary }>();

const keyFor = (runId: string, userId?: string) => `${runId}|${userId ?? ""}`;

/** A fresh entry, moved to the most recently used end; a stale one is dropped. */
function recall(key: string, now: number): ScanRunSummary | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  cache.delete(key);
  if (now - entry.at >= TTL_MS) return undefined;
  cache.set(key, entry);
  return entry.summary;
}

function remember(runId: string, userId: string | undefined, summary: ScanRunSummary, now: number): void {
  const key = keyFor(runId, userId);
  // A map iterates in insertion order, so deleting before setting keeps the oldest entry first.
  cache.delete(key);
  cache.set(key, { at: now, summary });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
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
  const cached = recall(keyFor(run.id, userId), now);
  if (cached) return report(run, cached, userId);
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
