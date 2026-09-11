import { scanRunSummary } from "@christopher/db";
import type { ScanRun } from "@christopher/db/schema";
import { db } from "./db";
export async function scanRunReport(run: ScanRun) {
  const summary = await scanRunSummary(db(), run.id);
  const historicalOnly = !summary.sources && !!run.finishedAt && run.companiesTotal > 0;
  if (historicalOnly) return { ...run, historicalOnly };
  const companiesOk = Math.min(run.companiesTotal, summary.companies_ok);
  return {
    ...run, historicalOnly,
    companiesOk,
    companiesFailed: run.finishedAt ? Math.max(0, run.companiesTotal - companiesOk) : 0,
    newRoles: summary.new_roles,
    closedRoles: summary.closed_roles,
  };
}
