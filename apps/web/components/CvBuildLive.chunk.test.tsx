// @vitest-environment jsdom
/**
 * The build narrative is a chunk of its own (components/CvBuildViews.tsx). A finished CV, the page
 * nearly every visit sees, must not fetch it until its build log is opened; and a chunk that cannot
 * be fetched (offline, or a deployment that replaced it) must say so in the log's place rather than
 * take the CV page down through the route's error boundary.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CvJournalStepWire } from "@/lib/cv-build-journal";
import { cvStepsSignature, stepFromWire } from "@/lib/cv-build-journal";
import type { CvProgressReading } from "@/lib/cv-progress-types";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("next/dynamic", async () => {
  const appDynamic = (await import("next/dist/shared/lib/app-dynamic")) as { default: unknown };
  const dynamic = appDynamic.default as { default?: unknown };
  return { default: dynamic.default ?? dynamic };
});
// The views' chunk: counted when it is asked for, and unreachable, as a failed chunk is.
const views = vi.hoisted(() => ({ requested: 0 }));
vi.mock("./CvBuildViews", () => {
  views.requested++;
  throw new Error("Failed to fetch dynamically imported module");
});

import { CvBuildLive } from "./CvBuildLive";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T0 = Date.parse("2026-09-18T18:00:00.000Z");
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const done = (seq: number, motion: string, detail: Record<string, unknown> = {}): CvJournalStepWire => ({
  id: `step-${seq}`, seq, attempt: 1, taskId: "task-1", stage: "publishing", motion, title: motion, status: "done",
  startedAt: iso(seq * 10), finishedAt: iso(seq * 10 + 2), ms: 2_000, detail, error: null, failure: null,
});
const steps = [done(1, "load_inputs"), done(2, "adopt_revision", { revision: "18-Sep-V2", draftId: "draft-2" })];
const finished: CvProgressReading = {
  active: false, live: false, version: "ready:::", phase: "done", failure: null, status: "ready", stage: null,
  createdAt: iso(0), signature: cvStepsSignature(steps.map(stepFromWire)), steps, build: null,
} as unknown as CvProgressReading;

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** A chunk request settles, then the render it held up is retried. */
async function settle() {
  for (let turn = 0; turn < 3; turn++) await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
}

it("fetches a finished CV's narrative only when its log is opened, and says so when it cannot", async () => {
  act(() => root.render(<CvBuildLive id="draft-1" mode="log" initial={finished} nowMs={T0 + 60_000} timeZone="UTC" versionLabel="18-Sep-V1" />));
  await settle();
  // Closed: the page shows the log's control and the adopted revision, and has asked for nothing.
  expect(views.requested).toBe(0);
  expect(container.querySelector('a[href="/cv/draft-2"]')?.textContent).toBe("open 18-Sep-V2");
  const toggle = [...container.querySelectorAll("button")].find((button) => button.textContent === "Show build log")!;
  act(() => toggle.click());
  await settle();
  expect(views.requested).toBeGreaterThan(0);
  // The chunk is unreachable: a sentence in the log's place, and the rest of the page still there.
  expect(container.textContent).toContain("The build log could not be loaded. Check your connection and reload the page.");
  expect(container.querySelector('a[href="/cv/draft-2"]')).not.toBeNull();
  expect(toggle.textContent).toBe("Hide build log");
});
