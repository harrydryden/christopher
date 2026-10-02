import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { HtmlScanProgress } from "@/lib/queries/html-scan-progress";
import type { WorkerStatus } from "@/lib/worker-status";

vi.mock("next/link", () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));

import { HtmlScanProgressCard } from "./HtmlScanProgressCard";

const now = new Date("2026-10-01T12:00:00Z");
const worker: WorkerStatus = { state: "healthy", heartbeat: null, ageMs: null, restartsLastHour: 0, restartsLastDay: 0, heapPressure: false };
const item: HtmlScanProgress = {
  generationId: "generation-one", companyId: "company-one", companyName: "Meridian", sourceId: "source-one",
  sourceUrl: "https://meridian.example/jobs", pagesRead: 2, publishedPages: 0, stagedPostings: 4,
  startedAt: new Date("2026-10-01T11:00:00Z"), expiresAt: new Date("2026-10-01T13:00:00Z"),
  taskStatus: "queued", runAfter: new Date("2026-10-01T12:05:00Z"), taskError: null,
};
const render = (progress: HtmlScanProgress) => renderToStaticMarkup(<HtmlScanProgressCard items={[progress]} worker={worker} now={now} />);

it("shows pages checked without claiming staged entries are available", () => {
  const html = render(item);
  expect(html).toContain("2 pages checked so far");
  expect(html).toContain("Matching roles will appear in Roles as results are ready");
  expect(html).not.toContain("4 job entries");
  expect(html).not.toContain("You can review any matching roles found so far");
  expect(html).not.toContain("Review roles</a>");
});

it("points to available matches after publication while keeping the check incomplete", () => {
  const html = render({ ...item, publishedPages: 1 });
  expect(html).toContain("You can review any matching roles found so far in Roles");
  expect(html).toContain("The rest of the listing is still being checked");
  expect(html).toContain('href="/"');
  expect(html).toContain("Review roles</a>");
  expect(html).not.toContain("8 new roles");
});

it("keeps an interrupted or expired read actionable without saying it is still checking", () => {
  const failed = render({ ...item, taskStatus: "failed", taskError: "Network stopped", publishedPages: 1 });
  expect(failed).toContain("Interrupted");
  expect(failed).toContain("Rescan");
  expect(failed).toContain("You can review any matching roles already found in Roles. Rescan to check the remaining pages.");

  const expired = render({ ...item, expiresAt: new Date("2026-10-01T11:30:00Z") });
  expect(expired).toContain("Interrupted");
  expect(expired).toContain("This read stopped before matching roles were ready");
  expect(expired).toContain("Rescan");
});

it("does not claim remaining pages are being checked while monitoring is offline", () => {
  const stoppedWorker = { ...worker, state: "stopped" as const };
  const available = renderToStaticMarkup(<HtmlScanProgressCard items={[{ ...item, publishedPages: 1 }]} worker={stoppedWorker} now={now} />);
  expect(available).toContain("Monitoring must resume before the remaining pages can be checked");
  expect(available).not.toContain("rest of the listing is still being checked");
  const waiting = renderToStaticMarkup(<HtmlScanProgressCard items={[item]} worker={stoppedWorker} now={now} />);
  expect(waiting).toContain("Matching roles can appear when monitoring resumes");
  expect(waiting).not.toContain("will appear in Roles as results are ready");
});
