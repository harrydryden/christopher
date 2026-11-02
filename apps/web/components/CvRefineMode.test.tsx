// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CvRefinementV1 } from "@col/core/cv-editing-modes";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/app/actions/cv-editing", () => ({ saveCvRefinement: vi.fn(), resetCvRefinement: vi.fn(), generateRefinedCv: vi.fn() }));
import { saveCvRefinement } from "@/app/actions/cv-editing";
import { CvRefineMode } from "./CvRefineMode";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

const existing: CvRefinementV1 = { id: "550d69d3-e692-424f-b2ea-5af851296fc9", version: 1, order: 0,
  kind: "exact_wording", target: { type: "summary", id: "c551e23a-a966-474c-81a8-7f7a3fd0dfd7" },
  text: "I managed the service desk.", dependencies: { descriptionVersionId: "e7b5c130-b58b-4c48-b4f5-f1c4a968f45b",
    sourceHash: "a".repeat(64), sourceIds: [] }, reset: false };

it("edits an existing stable refinement rather than creating a duplicate target", async () => {
  vi.mocked(saveCvRefinement).mockResolvedValue({ ok: true, version: 2 });
  act(() => root.render(<CvRefineMode contextId="context" initialVersion={1}
    source={{ kind: "baseline", id: "baseline", label: "Auto" }}
    targets={[{ type: "summary", id: existing.target.id, label: "Summary", sourceText: "Original Auto summary" }]}
    refinements={[existing]} />));
  const edit = [...container.querySelectorAll("button")].find(button => button.textContent === "Edit this")!;
  act(() => edit.click());
  expect(container.textContent).toContain("Original Auto summary");
  const field = container.querySelector("textarea")!;
  expect(field.value).toBe(existing.text);
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => { setter?.call(field, "I led the service desk."); field.dispatchEvent(new Event("input", { bubbles: true })); });
  const save = [...container.querySelectorAll("button")].find(button => button.textContent === "Update refinement · free")!;
  await act(async () => save.click());
  expect(saveCvRefinement).toHaveBeenCalledWith("context", 1, expect.objectContaining({
    id: existing.id, kind: "exact_wording", text: "I led the service desk.",
    target: existing.target, sourceKind: "baseline", sourceId: "baseline",
  }));
});

it("marks a changed source and blocks generation until the saved refinement is resolved", () => {
  act(() => root.render(<CvRefineMode contextId="context" initialVersion={1}
    source={{ kind: "baseline", id: "baseline", label: "Auto" }}
    targets={[{ type: "summary", id: existing.target.id, label: "Summary", sourceText: "Original Auto summary" }]}
    refinements={[existing]} conflicts={[{ id: existing.id, reason: "changed_source" }]} />));
  expect(container.textContent).toContain("Source evidence changed");
  const generate = [...container.querySelectorAll("button")].find(button => button.textContent === "Apply saved refinements · free")!;
  expect(generate.disabled).toBe(true);
  expect(container.textContent).toContain("Reset this");
});

it("offers free application of exact wording from a saved Auto-descended Refine edition", () => {
  act(() => root.render(<CvRefineMode contextId="context" initialVersion={1}
    source={{ kind: "draft", id: "refine-edition", label: "selected saved edition", autoOrigin: true }}
    targets={[{ type: "summary", id: existing.target.id, label: "Summary", sourceText: "Saved summary" }]}
    refinements={[existing]} />));
  expect([...container.querySelectorAll("button")].find(button => button.textContent === "Apply saved refinements · free")).toBeTruthy();
  expect(container.textContent).toContain("without generation or a CV credit");
  act(() => root.render(<CvRefineMode contextId="context" initialVersion={1}
    source={{ kind: "draft", id: "manual-edition", label: "Manual edition" }}
    targets={[{ type: "summary", id: existing.target.id, label: "Summary", sourceText: "Saved summary" }]}
    refinements={[existing]} />));
  expect([...container.querySelectorAll("button")].find(button => button.textContent === "Generate CV with saved refinements")).toBeTruthy();
});

it("keeps a typed buffer on its original source when the selected edition refreshes", () => {
  const props = { contextId: "context", initialVersion: 1, refinements: [] as CvRefinementV1[],
    targets: [{ type: "summary" as const, id: existing.target.id, label: "Summary", sourceText: "Original Auto summary" }] };
  act(() => root.render(<CvRefineMode {...props} source={{ kind: "baseline", id: "first", label: "First Auto" }} />));
  const field = container.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => { setter?.call(field, "Keep this wording."); field.dispatchEvent(new Event("input", { bubbles: true })); });
  act(() => root.render(<CvRefineMode {...props} source={{ kind: "baseline", id: "second", label: "Second Auto" }} />));
  expect(container.textContent).toContain("Your wording remains here for its original source");
  expect(container.querySelector("textarea")?.value).toBe("Keep this wording.");
  expect([...container.querySelectorAll("button")].find(button => button.textContent === "Save refinement · free")?.disabled).toBe(true);
  act(() => root.render(<CvRefineMode {...props} source={{ kind: "baseline", id: "first", label: "First Auto" }} />));
  expect(container.textContent).not.toContain("selected edition changed");
  expect(container.querySelector("textarea")?.value).toBe("Keep this wording.");
});
