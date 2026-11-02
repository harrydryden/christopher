// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CvRefinementV1 } from "@col/core/cv-editing-modes";
import type { CvContent } from "@col/core/cv";
import type { CvEditingTargets } from "@col/core/cv-editing-modes";

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

it("shows a mirrored skill once in the contextual document while keeping its old bullet target available", () => {
  const content = { name: "Alex", contact: "alex@example.test", summary: "Operations leader", gaps: [],
    sections: [{ entryId: "skill:ops", kind: "skill", heading: "Operations",
      bullets: ["Planning"], skillItems: ["Planning"] }] } as CvContent;
  const targets: CvEditingTargets = { version: 1, summaryId: "0d8e1b87-5b28-4938-9f5f-8973aa5e2ed1",
    sections: [{ entryId: "skill:ops", sectionId: "d4b3cb82-5675-454e-bcb3-faa53a4347a8",
      bulletIds: ["129ff20a-1a87-47eb-9228-620cb0444384"], skillIds: ["41f5c41d-860f-4e75-b7f5-fd3bcb66589d"] }] };
  act(() => root.render(<CvRefineMode contextId="context" initialVersion={1}
    source={{ kind: "baseline", id: "baseline", label: "Auto" }} sourceContent={content} sourceTargets={targets}
    targets={[{ type: "summary", id: targets.summaryId, label: "Summary", sourceText: content.summary },
      { type: "section", id: targets.sections[0]!.sectionId, label: "Operations · heading", sourceText: "Operations", entryId: "skill:ops" },
      { type: "bullet", id: targets.sections[0]!.bulletIds[0], label: "Operations · bullet 1", sourceText: "Planning", entryId: "skill:ops" },
      { type: "skill", id: targets.sections[0]!.skillIds[0], label: "Operations · skill 1", sourceText: "Planning", entryId: "skill:ops" }]}
    refinements={[]} />));
  const contextual = [...container.querySelectorAll("section[data-cv-source-entry]")];
  expect(contextual.find(row => row.textContent?.includes("Heading · Operations"))?.textContent)
    .not.toContain("Operations · heading · Operations");
  expect(contextual.filter(row => row.textContent?.includes("Planning"))).toHaveLength(1);
  expect(contextual.some(row => row.textContent?.includes("Operations · skill 1"))).toBe(true);
  const advanced = container.querySelector("details select")!;
  expect(advanced.textContent).toContain("Operations · bullet 1");
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  act(() => { (advanced as HTMLSelectElement).value = "2"; advanced.dispatchEvent(new Event("change", { bubbles: true })); });
  expect([...container.querySelectorAll("section[data-cv-source-entry]")].some(row =>
    row.textContent?.includes("Historical mirrored target") && !!row.querySelector("textarea"))).toBe(true);
  vi.unstubAllGlobals();
});

it("updates an existing remembered item order by its stable rule ID", async () => {
  const sectionId = "d4b3cb82-5675-454e-bcb3-faa53a4347a8";
  const itemId = "41f5c41d-860f-4e75-b7f5-fd3bcb66589d";
  const targets: CvEditingTargets = { version: 1, summaryId: "0d8e1b87-5b28-4938-9f5f-8973aa5e2ed1",
    sections: [{ entryId: "skill:ops", sectionId, bulletIds: ["129ff20a-1a87-47eb-9228-620cb0444384"], skillIds: [itemId] }] };
  const content = { name: "Alex", contact: "alex@example.test", summary: "Operations leader", gaps: [],
    sections: [{ entryId: "skill:ops", kind: "skill", heading: "Operations",
      bullets: ["Planning"], skillItems: ["Planning"] }] } as CvContent;
  const rule: CvRefinementV1 = { ...existing, id: "5e7f85a4-fdab-42c9-a221-b730f5c2bb9b",
    kind: "structured", target: { type: "selection" }, text: undefined,
    structured: { kind: "item_order", sectionIds: [sectionId], itemIds: { [sectionId]: [itemId] } } };
  vi.mocked(saveCvRefinement).mockResolvedValue({ ok: true, version: 2 });
  act(() => root.render(<CvRefineMode contextId="context" initialVersion={1}
    source={{ kind: "baseline", id: "baseline", label: "Auto" }} sourceContent={content} sourceTargets={targets}
    targets={[{ type: "summary", id: targets.summaryId, label: "Summary", sourceText: content.summary }]}
    refinements={[rule]} />));
  act(() => [...container.querySelectorAll("button")].find(button => button.textContent === "Edit this")!.click());
  const save = [...container.querySelectorAll("button")].find(button => button.textContent === "Update order · free")!;
  await act(async () => save.click());
  expect(saveCvRefinement).toHaveBeenCalledWith("context", 1, expect.objectContaining({
    id: rule.id, kind: "structured", structured: rule.structured,
  }));
});
