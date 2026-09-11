import { localDateParts } from "@christopher/core";
import type { ScanRun } from "@christopher/db/schema";
export function scanBannerText(run: ScanRun | null, tz: string, now: Date): string {
  if (!run) return "No scan batches yet";
  const start = localDateParts(run.startedAt, tz);
  const today = localDateParts(now, tz);
  const date = start.ymd === today.ymd ? "Today" : start.ymd;
  const prefix = `${run.trigger === "schedule" ? "Scheduled" : "Manual"} batch · ${date} ${start.hm}`;
  if (!run.finishedAt) return `${prefix} · In progress · ${run.companiesOk} of ${run.companiesTotal} companies successful so far`;
  if (!run.companiesTotal) return `${prefix} · No companies due`;
  return `${prefix} · ${run.companiesOk} of ${run.companiesTotal} companies successful${run.companiesFailed ? ` · ${run.companiesFailed} incomplete or failed` : ""} · ${run.newRoles} new ${run.newRoles === 1 ? "match" : "matches"} added`;
}
