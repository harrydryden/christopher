// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CvRefinementV1 } from "@col/core/cv-editing-modes";
import type { CvContent } from "@col/core/cv";
import type { CvEditingTargets } from "@col/core/cv-editing-modes";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/app/actions/cv-editing", () => ({ saveCvRefinement: vi.fn(), saveAndUpdateCvExactRefinement: vi.fn(),
  resetCvRefinement: vi.fn(), generateRefinedCv: vi.fn() }));
import { saveCvRefinement, saveAndUpdateCvExactRefinement } from "@/app/actions/cv-editing";
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

it("gives the prefilled wording an exact label in server-rendered markup", () => {
  const html = renderToStaticMarkup(<CvRefineMode contextId="context" initialVersion={1}
    source={{ kind: "baseline", id: "baseline", label: "Auto" }}
    targets={[{ type: "summary", id: existing.target.id, label: "Summary", sourceText: "Saved summary text" }]}
    refinements={[]} />);
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const label = [...parsed.querySelectorAll("label")].find(row => row.textContent === "Exact wording")!;
  expect(label).toBeTruthy();
  expect(label.htmlFor).toBe("cv-refine-wording");
  expect(parsed.getElementById(label.htmlFor)?.tagName).toBe("TEXTAREA");
  expect(label.textContent).not.toContain("Saved summary text");
});

it("edits an existing stable refinement rather than creating a duplicate target", async () => {
  vi.mocked(saveAndUpdateCvExactRefinement).mockResolvedValue({ ok: true, version: 2, draftId: "new", revision: 2, charged: false });
  act(() => root.render(<CvRefineMode contextId="context" initialVersion={1}
    source={{ kind: "baseline", id: "baseline", label: "Auto" }}
    targets={[{ type: "summary", id: existing.target.id, label: "Summary", sourceText: "Original Auto summary" }]}
    refinements={[existing]} />));
  const edit = [...container.querySelectorAll("button")].find(button => button.textContent === "Edit")!;
  act(() => edit.click());
  expect(container.textContent).toContain("Original Auto summary");
  const field = container.querySelector("textarea")!;
  expect(field.value).toBe(existing.text);
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => { setter?.call(field, "I led the service desk."); field.dispatchEvent(new Event("input", { bubbles: true })); });
  const save = [...container.querySelectorAll("button")].find(button => button.textContent === "Save and update CV · free")!;
  await act(async () => save.click());
  expect(saveAndUpdateCvExactRefinement).toHaveBeenCalledWith("context", 1,
    { kind: "baseline", id: "baseline", revision: undefined }, expect.objectContaining({
    id: existing.id, text: "I led the service desk.", target: existing.target,
  }));
});

it("prefills the current summary and updates its remembered rule on a second one-step save", async () => {
  vi.mocked(saveAndUpdateCvExactRefinement).mockResolvedValue({ ok: true, version: 2,
    draftId: "first-child", revision: 2, charged: false });
  const target = { type: "summary" as const, id: existing.target.id, label: "Summary", sourceText: "Original Auto summary" };
  act(() => root.render(<CvRefineMode contextId="context" initialVersion={1}
    source={{ kind: "baseline", id: "baseline", label: "Auto" }} targets={[target]} refinements={[]} />));
  const field = container.querySelector<HTMLTextAreaElement>("textarea")!;
  const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button =>
    button.textContent === "Save and update CV · free")!;
  expect(field.value).toBe("Original Auto summary");
  expect(save.disabled).toBe(true);
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => { setter.call(field, "First exact summary"); field.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => save.click());
  expect(container.textContent).toContain("CV updated. This wording is remembered for this role.");
  expect(field.disabled).toBe(true);
  expect(container.textContent).toContain("Updating the selected CV");
  expect(container.textContent).toContain("Refresh saved CV");
  expect(saveAndUpdateCvExactRefinement).toHaveBeenCalledWith("context", 1,
    { kind: "baseline", id: "baseline", revision: undefined },
    expect.objectContaining({ target: existing.target, text: "First exact summary", requestKey: expect.any(String) }));
  act(() => root.render(<CvRefineMode contextId="context" initialVersion={2}
    source={{ kind: "draft", id: "first-child", revision: 2, label: "Current CV", autoOrigin: true }}
    targets={[{ ...target, sourceText: "First exact summary" }]} refinements={[existing]} />));
  expect(field.value).toBe("First exact summary");
  expect(field.disabled).toBe(false);
  act(() => { setter.call(field, "Second exact summary"); field.dispatchEvent(new Event("input", { bubbles: true })); });
  vi.mocked(saveAndUpdateCvExactRefinement).mockResolvedValue({ ok: true, version: 3,
    draftId: "second-child", revision: 3, charged: false });
  await act(async () => save.click());
  expect(saveAndUpdateCvExactRefinement).toHaveBeenLastCalledWith("context", 2,
    { kind: "draft", id: "first-child", revision: 2 }, expect.objectContaining({
      id: existing.id, target: existing.target, text: "Second exact summary", requestKey: expect.any(String),
    }));
});

it("retains a hidden instruction and the selected bullet through the exact-save handover", async () => {
  vi.mocked(saveAndUpdateCvExactRefinement).mockResolvedValue({ ok: true, version: 2,
    draftId: "child", revision: 2, charged: false });
  const summary = { type: "summary" as const, id: existing.target.id, label: "Summary", sourceText: "Summary one" };
  const bullet = { type: "bullet" as const, id: "2f43b6f0-e198-4cf6-b0fe-cb08a2760794",
    label: "Experience bullet", sourceText: "Bullet one" };
  act(() => root.render(<CvRefineMode contextId="context" initialVersion={1}
    source={{ kind: "baseline", id: "baseline", label: "Auto" }} targets={[summary, bullet]} refinements={[]} />));
  const editBullet = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button =>
    button.textContent === "Edit wording" && button.closest("section")?.textContent?.includes("Experience bullet"))!;
  act(() => editBullet.click());
  const field = container.querySelector<HTMLTextAreaElement>("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')][1]!.click());
  act(() => { setter.call(field, "Keep this hidden instruction"); field.dispatchEvent(new Event("input", { bubbles: true })); });
  act(() => [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')][0]!.click());
  act(() => { setter.call(field, "Bullet two"); field.dispatchEvent(new Event("input", { bubbles: true })); });
  const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button =>
    button.textContent === "Save and update CV · free")!;
  await act(async () => save.click());
  expect(field.disabled).toBe(true);
  expect([...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].every(input => input.disabled)).toBe(true);
  act(() => root.render(<CvRefineMode contextId="context" initialVersion={2}
    source={{ kind: "draft", id: "child", revision: 2, label: "Current", autoOrigin: true }}
    targets={[summary, { ...bullet, sourceText: "Bullet two" }]} refinements={[]} />));
  expect(field.disabled).toBe(false);
  expect(field.value).toBe("Bullet two");
  act(() => [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')][1]!.click());
  expect(field.value).toBe("Keep this hidden instruction");
  expect(container.querySelector('[data-cv-mode-dirty="true"]')).not.toBeNull();
});

it("keeps an unsaved section order while an exact summary save selects its child", async () => {
  vi.mocked(saveAndUpdateCvExactRefinement).mockResolvedValue({ ok: true, version: 2,
    draftId: "child", revision: 2, charged: false });
  const summaryId = "c551e23a-a966-474c-81a8-7f7a3fd0dfd7";
  const content = { name: "Alex", contact: "alex@example.test", summary: "Old summary", gaps: [],
    sections: [{ entryId: "first", kind: "experience", heading: "First", bullets: ["One"] },
      { entryId: "second", kind: "experience", heading: "Second", bullets: ["Two"] }] } as CvContent;
  const targets: CvEditingTargets = { version: 1, summaryId,
    sections: [{ entryId: "first", sectionId: "4b1fa6b2-bc7e-4657-b02f-a91fcce78625",
      bulletIds: ["5f8e019a-8e9b-4226-9e21-b8ae476f81d9"], skillIds: [] },
    { entryId: "second", sectionId: "22770533-cd85-45bb-b02e-b44f3c4627e3",
      bulletIds: ["41f5c41d-860f-4e75-b7f5-fd3bcb66589d"], skillIds: [] }] };
  const props = { contextId: "context", targets: [{ type: "summary" as const, id: summaryId,
    label: "Summary", sourceText: "Old summary" }], refinements: [] as CvRefinementV1[],
    sourceContent: content, sourceTargets: targets };
  act(() => root.render(<CvRefineMode {...props} initialVersion={1}
    source={{ kind: "baseline", id: "baseline", label: "Auto" }} />));
  act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button =>
    button.textContent === "Section and skill order")!.click());
  act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button =>
    button.getAttribute("aria-label") === "Move First down")!.click());
  act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button =>
    button.textContent === "Wording or instruction")!.click());
  const field = container.querySelector<HTMLTextAreaElement>("textarea")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "New summary");
    field.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button =>
    button.textContent === "Save and update CV · free")!.click());
  act(() => root.render(<CvRefineMode {...props} initialVersion={2}
    source={{ kind: "draft", id: "child", revision: 2, label: "Current CV", autoOrigin: true }}
    sourceContent={{ ...content, summary: "New summary" }}
    targets={[{ ...props.targets[0]!, sourceText: "New summary" }]} />));
  expect(field.disabled).toBe(false);
  expect(container.querySelector('[data-cv-mode-dirty="true"]')).not.toBeNull();
  act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button =>
    button.textContent === "Section and skill order")!.click());
  const rows = [...container.querySelectorAll("div.border.border-line-muted.p-2")].filter(row =>
    row.textContent?.includes("First") || row.textContent?.includes("Second"));
  expect(rows[0]?.textContent).toContain("Second");
});

it("keeps an unsaved exact buffer when instruction is selected and the source changes", () => {
  const props = { contextId: "context", initialVersion: 1, refinements: [] as CvRefinementV1[],
    targets: [{ type: "summary" as const, id: existing.target.id, label: "Summary", sourceText: "Original summary" }] };
  act(() => root.render(<CvRefineMode {...props} source={{ kind: "baseline", id: "first", label: "First" }} />));
  const field = container.querySelector<HTMLTextAreaElement>("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => { setter.call(field, "My unsaved exact wording"); field.dispatchEvent(new Event("input", { bubbles: true })); });
  const instruction = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')][1]!;
  act(() => instruction.click());
  expect(container.querySelector('[data-cv-mode-dirty="true"]')).not.toBeNull();
  act(() => root.render(<CvRefineMode {...props} source={{ kind: "baseline", id: "second", label: "Second" }} />));
  expect(container.textContent).toContain("Restore original saved edition");
  const exact = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')][0]!;
  act(() => exact.click());
  expect(field.value).toBe("My unsaved exact wording");
  expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(button =>
    button.textContent === "Save and update CV · free")?.disabled).toBe(true);
});

it("keeps the same save intent and wording after a failed one-step request", async () => {
  vi.mocked(saveAndUpdateCvExactRefinement).mockResolvedValueOnce({ ok: false, error: "Please try again." })
    .mockResolvedValueOnce({ ok: true, version: 2, draftId: "child", revision: 2, charged: false });
  act(() => root.render(<CvRefineMode contextId="context" initialVersion={1}
    source={{ kind: "baseline", id: "baseline", label: "Auto" }}
    targets={[{ type: "summary", id: existing.target.id, label: "Summary", sourceText: "Saved summary" }]}
    refinements={[]} />));
  const field = container.querySelector<HTMLTextAreaElement>("textarea")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Edited summary");
    field.dispatchEvent(new Event("input", { bubbles: true })); });
  const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button =>
    button.textContent === "Save and update CV · free")!;
  await act(async () => save.click());
  expect(field.value).toBe("Edited summary");
  expect(container.textContent).toContain("Please try again.");
  await act(async () => save.click());
  const calls = vi.mocked(saveAndUpdateCvExactRefinement).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[0]?.[3].requestKey).toBe(calls[1]?.[3].requestKey);
  expect(container.textContent).toContain("CV updated. This wording is remembered for this role.");
});

it("does not offer another Apply after the exact rule is already in the selected CV", () => {
  act(() => root.render(<CvRefineMode contextId="context" initialVersion={2}
    source={{ kind: "draft", id: "child", revision: 2, label: "Current CV", autoOrigin: true }}
    targets={[{ type: "summary", id: existing.target.id, label: "Summary", sourceText: existing.text! }]}
    refinements={[existing]} appliedRefinements={[{ id: existing.id, version: existing.version }]} />));
  expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(existing.text);
  expect(container.textContent).not.toContain("Apply saved refinements");
  expect(container.textContent).toContain("Forget for future builds");
});

it("marks a changed source and blocks generation until the saved refinement is resolved", () => {
  act(() => root.render(<CvRefineMode contextId="context" initialVersion={1}
    source={{ kind: "baseline", id: "baseline", label: "Auto" }}
    targets={[{ type: "summary", id: existing.target.id, label: "Summary", sourceText: "Original Auto summary" }]}
    refinements={[existing]} conflicts={[{ id: existing.id, reason: "changed_source" }]} />));
  expect(container.textContent).toContain("Source evidence changed");
  const generate = [...container.querySelectorAll("button")].find(button => button.textContent === "Apply saved refinements · free")!;
  expect(generate.disabled).toBe(true);
  expect(container.textContent).toContain("Forget for future builds");
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
  expect([...container.querySelectorAll("button")].find(button => button.textContent === "Save and update CV · free")?.disabled).toBe(true);
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
