/**
 * The per-instance summary cache. The database side of the summary is covered in
 * lib/queries/scan-summary.test.ts; this is only the bound and what it keeps.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ScanRun } from "@ava/db/schema";

const summaries = vi.hoisted(() => vi.fn(async (_db: unknown, ids: string[]) => new Map(ids.map((id) => [id, { sources: 1, pending: 0, companies_ok: 1, new_roles: 2, closed_roles: 0 }]))));
vi.mock("@ava/db", () => ({ scanRunSummaries: summaries }));
vi.mock("./db", () => ({ db: () => ({}) }));

import { MAX_ENTRIES, clearScanSummaryCache, scanRunReport } from "./scan-run-report";

const run = { id: "run-1", startedAt: new Date("2026-09-11T05:00:00Z"), finishedAt: new Date("2026-09-11T06:00:00Z"), companiesTotal: 1 } as ScanRun;
const user = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-11T07:00:00Z"));
  clearScanSummaryCache();
  summaries.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

it("keeps serving recent accounts from memory when more accounts than its bound ask at once", async () => {
  // More accounts than the bound within half a minute: the old cache emptied itself here and
  // served nobody; the bounded one drops only the least recently used.
  const accounts = MAX_ENTRIES + 250;
  for (let n = 0; n < accounts; n++) await scanRunReport(run, user(n));
  expect(summaries).toHaveBeenCalledTimes(accounts);
  summaries.mockClear();

  for (let n = accounts - MAX_ENTRIES; n < accounts; n++) await scanRunReport(run, user(n));
  expect(summaries).not.toHaveBeenCalled();

  await scanRunReport(run, user(0));
  expect(summaries).toHaveBeenCalledTimes(1);
});

it("evicts the least recently used entry, not the oldest written", async () => {
  for (let n = 0; n < MAX_ENTRIES; n++) await scanRunReport(run, user(n));
  // Reading the first account again makes it the most recent, so the next new account evicts the second.
  await scanRunReport(run, user(0));
  await scanRunReport(run, user(MAX_ENTRIES));
  summaries.mockClear();
  await scanRunReport(run, user(0));
  expect(summaries).not.toHaveBeenCalled();
  await scanRunReport(run, user(1));
  expect(summaries).toHaveBeenCalledTimes(1);
});

it("reads through again once an entry is half a minute old", async () => {
  await scanRunReport(run, user(1));
  vi.advanceTimersByTime(29_000);
  await scanRunReport(run, user(1));
  expect(summaries).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1_000);
  await scanRunReport(run, user(1));
  expect(summaries).toHaveBeenCalledTimes(2);
});
