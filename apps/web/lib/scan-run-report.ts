import { scanRunSummaries, type ScanRunSummary } from "@col/db";
import type { ScanRun } from "@col/db/schema";
import { db } from "./db";

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

/**
 * Several runs (Health's history) in one query rather than one query per run. A run is shared;
 * with a `userId` the counts cover only the companies that account follows.
 */
export async function scanRunReports(runs: ScanRun[], userId?: string) {
  if (!runs.length) return [];
  const summaries = await scanRunSummaries(db(), runs.map((run) => run.id), userId);
  return runs.map((run) => report(run, summaries.get(run.id)!, userId));
}
