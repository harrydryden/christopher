// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { CvTargetingView } from "@col/core/cv-targeting";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("@/app/actions/cv-targeting", () => ({ confirmCvTargetingPriorities: vi.fn(), reviseFailedCvTargeting: vi.fn() }));
import { reviseFailedCvTargeting } from "@/app/actions/cv-targeting";
import { CvTargetingConfirmation } from "./CvTargetingPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const view = { draftId: "draft-1", revision: 4, status: "confirmed",
  source: { libraryVersion: 1, evidenceHash: "a".repeat(64), jobDescriptionHash: "b".repeat(64) },
  rubricKey: "c".repeat(64), entries: [
    { entryId: "ev-manager", kind: "experience", heading: "Operations Manager", treatment: "feature" },
    { entryId: "ev-calder", kind: "experience", heading: "Service Lead", treatment: "feature" },
  ], priorities: Array.from({ length: 3 }, (_, index) => ({ id: `r-${index}`, label: `Requirement ${index}`,
    quote: "Lead operations", importance: "responsibility", category: "experience", selected: true, evidenceEntryIds: [] })),
  essentialOmissionIds: [], acknowledgedEssentialOmissionIds: [], summaryNeedsReview: false,
  presentation: { maxPages: 1, bodySizePt: 12 },
} as CvTargetingView;
let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it("changes the failed CV's own maximum and evidence before same-draft recovery", async () => {
  vi.mocked(reviseFailedCvTargeting).mockResolvedValue({ ok: true, destination: "/cv/draft-1" });
  act(() => root.render(<CvTargetingConfirmation view={view} blocked={null} recovery />));
  const treatment = container.querySelector<HTMLSelectElement>('select[aria-label="Operations Manager treatment"]')!;
  const pages = container.querySelector<HTMLSelectElement>('select[aria-label="Maximum pages"]')!;
  act(() => { treatment.value = "summarise"; treatment.dispatchEvent(new Event("change", { bubbles: true }));
    pages.value = "2"; pages.dispatchEvent(new Event("change", { bubbles: true })); });
  const button = [...container.querySelectorAll("button")].find(item => item.textContent === "Update choices and retry this CV")!;
  await act(async () => button.click());
  expect(reviseFailedCvTargeting).toHaveBeenCalledWith("draft-1", expect.objectContaining({
    expectedRevision: 4, expectedRubricKey: "c".repeat(64),
    choices: expect.objectContaining({ presentation: { maxPages: 2, bodySizePt: 12 },
      entries: expect.arrayContaining([expect.objectContaining({ entryId: "ev-manager", treatment: "summarise" })]) }),
  }));
  expect(push).toHaveBeenCalledWith("/cv/draft-1");
});
