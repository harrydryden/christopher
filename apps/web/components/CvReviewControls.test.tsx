// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/app/actions/cv", () => ({ dismissCvReviewItem: vi.fn(), finaliseCvDraft: vi.fn(async () => ({ ok: true })) }));
import { finaliseCvDraft } from "@/app/actions/cv";
import { CvReviewControls } from "./CvReviewControls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const base = { id: "draft-id", rows: [], decision: null, factualRowIds: [],
  assessmentHash: "current-hash", assessedAt: "current-time", canFinalise: true };

it("submits one explicit acknowledgement for omitted-summary and page warnings", async () => {
  act(() => root.render(<CvReviewControls {...base} summaryIssue="The summary cites omitted Experience."
    overPages={3} maxPages={2} />));
  expect(container.textContent).toContain("The summary cites omitted Experience.");
  expect(container.textContent).toContain("3 pages against your chosen 2-page limit");
  const button = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(button.textContent).toBe("Finalise with warnings");
  const reviewed = container.querySelector<HTMLInputElement>('input[name="reviewed"]')!;
  expect(reviewed.required).toBe(true);
  await act(async () => { reviewed.click(); button.click(); });
  expect(finaliseCvDraft).toHaveBeenCalledOnce();
  const form = vi.mocked(finaliseCvDraft).mock.calls[0]![2];
  expect(form.get("skipReview")).toBe("on");
  expect(form.get("assessmentHash")).toBe("current-hash");
  expect(form.get("assessedAt")).toBe("current-time");
});

it("keeps ordinary finalisation distinct when no warning needs overriding", () => {
  act(() => root.render(<CvReviewControls {...base} />));
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent).toBe("Finalise this CV");
  expect(container.querySelector('input[name="skipReview"]')).toBeNull();
});
