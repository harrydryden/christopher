// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { CvJournalStep } from "@/lib/cv-build-journal";
import type { CvProgressReading } from "@/lib/cv-progress-types";

vi.mock("@/lib/cv-build-narrative", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cv-build-narrative")>();
  return { ...actual, narrateBuild: vi.fn(actual.narrateBuild) };
});

import { narrateBuild } from "@/lib/cv-build-narrative";
import { CvBuildScreen } from "./CvBuildViews";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("does not compute the detailed narrative on clock ticks until it is opened", async () => {
  const date = new Date("2026-10-30T12:00:00.000Z");
  const steps: CvJournalStep[] = [{ id: "step-1", seq: 1, attempt: 1, stage: "writing", motion: "draft",
    title: "Writing", status: "running", startedAt: date, finishedAt: null, ms: null, detail: {}, error: null, failure: null }];
  const build = { phase: "progressing", message: "Writing your CV.", tone: "blue", attempts: 1,
    maxAttempts: 3, lastProgressAt: date.toISOString(), retryAt: null, taskError: null, title: null } as const;
  const reading = { status: "generating", stage: "writing", createdAt: date.toISOString(), active: true, live: true } as CvProgressReading;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const render = (now: number) => root.render(<CvBuildScreen steps={steps} now={now} context={{}} medians={{}}
    reading={reading} build={build} />);
  try {
    vi.mocked(narrateBuild).mockClear();
    act(() => render(date.getTime()));
    act(() => render(date.getTime() + 1_000));
    expect(narrateBuild).not.toHaveBeenCalled();
    const toggle = [...container.querySelectorAll("button")].find(button => button.textContent === "Show detailed build log")!;
    await act(async () => toggle.click());
    expect(narrateBuild).toHaveBeenCalledTimes(1);
    act(() => render(date.getTime() + 2_000));
    expect(narrateBuild).toHaveBeenCalledTimes(2);
    await act(async () => toggle.click());
    act(() => render(date.getTime() + 3_000));
    expect(narrateBuild).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount()); container.remove();
  }
});
