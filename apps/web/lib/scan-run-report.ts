import { scanRunSummary } from "@christopher/db";
import type { ScanRun } from "@christopher/db/schema";
import { db } from "./db";

/** A run is shared; with a `userId` the counts cover only the companies that account follows. */
export async function scanRunReport(run: ScanRun, userId?: string) {
  const summary = await scanRunSummary(db(), run.id, userId);
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
