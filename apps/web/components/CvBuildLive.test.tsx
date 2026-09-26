// @vitest-environment jsdom
/**
 * The CV page's poller against the progress feed, in a browser: rows it can trust, rows whose
 * signature disagrees with the ledger (read again whole, once), and a draft that has gone — which
 * hands the page to the server once and stops, rather than backing off for ever over a silent page.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CvJournalStepWire } from "@/lib/cv-build-journal";
import { cvStepsSignature, stepFromWire } from "@/lib/cv-build-journal";
import type { CvProgressReading } from "@/lib/cv-progress-types";
import { FIRST_POLL_MS } from "@/lib/polling";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

import { CvBuildLive } from "./CvBuildLive";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T0 = Date.parse("2026-09-18T18:00:00.000Z");
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function wire(seq: number, motion: string, status: CvJournalStepWire["status"], detail: Record<string, unknown> = {}): CvJournalStepWire {
  return {
    id: `step-${seq}`, seq, attempt: 1, taskId: "task-1", stage: "preparing", motion, title: motion, status,
    startedAt: iso(seq * 10), finishedAt: status === "running" ? null : iso(seq * 10 + 2), ms: status === "running" ? null : 2_000,
    detail, error: null, failure: null,
  };
}
const sign = (steps: CvJournalStepWire[]) => cvStepsSignature(steps.map(stepFromWire));

function reading(steps: CvJournalStepWire[], signature = sign(steps)): CvProgressReading {
  return {
    active: true, live: true, version: "generating:::progressing", phase: "progressing", failure: null, status: "generating",
    stage: "preparing", createdAt: iso(0), signature, steps,
    build: {
      phase: "progressing", message: "Working on it.", title: null, tone: "blue", attempts: 1, maxAttempts: 3,
      lastProgressAt: iso(10), retryAt: null, taskError: null,
    },
  };
}
const ok = (body: CvProgressReading) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const gone = (status: number) => ({ ok: false, status, json: async () => ({ ok: false }) }) as unknown as Response;

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers({ now: T0 + 60_000 });
  router.refresh.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

for (const status of [404, 401]) {
  it(`reads again whole once when the rows disagree, then on a ${status} hands the page to the server and stops`, async () => {
    const first = [wire(1, "load_inputs", "done")];
    const second = [wire(2, "rubric", "running")];
    const fetch = vi
      .fn<(url: string) => Promise<Response>>()
      // Rows the page can trust: its merged rows sign as the ledger does.
      .mockResolvedValueOnce(ok(reading([], sign(first))))
      // A delta whose merged rows sign differently from the ledger: something was missed.
      .mockResolvedValueOnce(ok(reading(second, "3:1:" + iso(40))))
      // The draft was deleted, or the session ended, before the resync could land.
      .mockResolvedValueOnce(gone(status));
    vi.stubGlobal("fetch", fetch);

    act(() => {
      root.render(<CvBuildLive id="draft-1" mode="build" initial={reading(first)} nowMs={T0 + 60_000} timeZone="UTC" versionLabel="18-Sep-V1" />);
    });
    await advance(FIRST_POLL_MS);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toContain("after=1&");
    // The next reading comes on its own schedule, and its mismatch is followed at once by a
    // replacing read of the whole ledger (`after=0`).
    await advance(60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[1]![0]).toContain("after=1&");
    expect(fetch.mock.calls[2]![0]).toContain("after=0&");
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // Stopped: nothing more is asked however long the page stays open.
    await advance(10 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
}

it("keeps backing off over a failure that a later reading can recover from", async () => {
  const fetch = vi.fn<(url: string) => Promise<Response>>().mockResolvedValue(gone(503));
  vi.stubGlobal("fetch", fetch);
  act(() => {
    root.render(<CvBuildLive id="draft-1" mode="build" initial={reading([wire(1, "load_inputs", "done")])} nowMs={T0 + 60_000} timeZone="UTC" versionLabel="18-Sep-V1" />);
  });
  await advance(FIRST_POLL_MS + 5 * 60_000);
  expect(fetch.mock.calls.length).toBeGreaterThan(2);
  expect(router.refresh).not.toHaveBeenCalled();
});

it("counts every elapsed figure on the server's clock, whatever the browser's says", async () => {
  // The browser's clock is ten minutes behind the server that rendered the page.
  const serverNow = T0 + 60_000;
  vi.setSystemTime(serverNow - 10 * 60_000);
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  const running = { ...wire(1, "write", "running"), startedAt: iso(30), title: "Writing the CV" };
  act(() => {
    root.render(<CvBuildLive id="draft-1" mode="build" initial={reading([running])} nowMs={serverNow} timeZone="UTC" versionLabel="18-Sep-V1" />);
  });
  await advance(5_000);
  // 30 s had passed on the server when it rendered, and five more since: not "0 s" for ten minutes.
  expect(container.textContent).toContain("Writing the CV · running 35 s");
  expect(container.textContent).toContain("Started 1m ago");
});
