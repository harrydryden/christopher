import { expect, it } from "vitest";
import type { ScanRun } from "@christopher/db/schema";
import { scanBannerText } from "./scan-banner";
const now = new Date("2026-09-11T12:00:00Z");
const run = { startedAt: new Date("2026-09-11T05:00:00Z"), finishedAt: now, trigger: "schedule", companiesTotal: 4, companiesOk: 3, companiesFailed: 1, newRoles: 0 } as ScanRun;
it("identifies batch scope, local start time and incomplete companies", () => {
  expect(scanBannerText(run, "Europe/London", now)).toBe("Scheduled batch · Today 06:00 · 3 of 4 companies successful · 1 incomplete or failed · 0 new matches added");
});
it("does not present unfinished zero counters as final results", () => {
  const text = scanBannerText({ ...run, finishedAt: null }, "Europe/London", now);
  expect(text).toContain("In progress");
  expect(text).not.toContain("0 new");
});
it("labels empty scheduled batches without implying all tracked companies were scanned", () => {
  expect(scanBannerText({ ...run, companiesTotal: 0 }, "Europe/London", now)).toContain("No companies due");
  expect(scanBannerText(null, "Europe/London", now)).toBe("No scan batches yet");
});
