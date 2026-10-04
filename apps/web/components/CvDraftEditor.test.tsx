// @vitest-environment jsdom
/**
 * The CV editor's preview loads the content check on first use. When that chunk cannot be fetched
 * (offline, or a deployment that replaced it), the button must say so, not quietly do nothing.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CV_THEME } from "@ava/core/cv-theme-values";
import type { CvContent } from "@ava/core/cv";

vi.mock("@/app/actions/cv", () => ({ saveCvDraft: vi.fn() }));
// The lazily loaded check, unreachable: `import("@ava/core/cv")` rejects as a failed chunk would.
vi.mock("@ava/core/cv", () => { throw new Error("Failed to fetch dynamically imported module"); });

import { CvDraftEditor } from "./CvDraftEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const content = {
  name: "Ada Lovelace", contact: "ada@example.com", summary: "Analyst.", gaps: [],
  sections: [{ entryId: "e-1", kind: "experience", heading: "Analyst, Engines Ltd", bullets: ["Wrote the first program."] }],
} as unknown as CvContent;

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

it("stringifies the saved revision once, not on every keystroke, and still knows when it is edited", () => {
  act(() => root.render(<CvDraftEditor id="cv-1" content={content} theme={DEFAULT_CV_THEME} />));
  const profile = container.querySelector<HTMLTextAreaElement>('textarea[name="summary"]')!;
  const type = (value: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(profile, value);
    profile.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    for (const value of ["Analyst!", "Analyst!!", "Analyst!!!"]) act(() => type(value));
    // Only the edited candidate is stringified per keystroke; the saved revision (whose profile is
    // still "Analyst.") is not stringified again.
    const saved = stringify.mock.calls.filter(([value]) => (value as { summary?: string } | null)?.summary === "Analyst.");
    expect(saved).toHaveLength(0);
    expect(container.textContent).toContain("Unsaved changes");
    act(() => type("Analyst."));
    expect(container.textContent).not.toContain("Unsaved changes");
  } finally {
    stringify.mockRestore();
  }
});

it("says the preview could not load when its check cannot be fetched", async () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  try {
    act(() => root.render(<CvDraftEditor id="cv-1" content={content} theme={DEFAULT_CV_THEME} />));
    const button = [...container.querySelectorAll("button")].find(el => el.textContent === "Preview current edits")!;
    await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load the preview");
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it("lets a reviewer add and remove a skill section without changing Library sections", () => {
  act(() => root.render(<CvDraftEditor id="cv-1" content={content} theme={DEFAULT_CV_THEME} />));
  const button = (label: string) => [...container.querySelectorAll("button")].find((element) => element.textContent === label)!;
  act(() => button("Add skill section").click());
  const skill = container.querySelector<HTMLInputElement>('[aria-label="Skill 1 in new section"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(skill, "Python");
    skill.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelector('[name="addedSkills"]')?.getAttribute("value")).toContain("manual-skill-");
  expect(container.querySelector('[data-cv-editor-dirty="true"]')).not.toBeNull();
  act(() => button("Remove skill section").click());
  expect(container.querySelector('[name="addedSkills"]')?.getAttribute("value")).toBe("[]");
  expect(container.querySelector('[data-cv-editor-dirty="false"]')).not.toBeNull();
});

it("offers saved Library skills and visibly stops a section at ten", () => {
  const skillContent = { ...content, sections: [{ entryId: "s-1", kind: "skill", heading: "Tools", bullets: ["A"], skillItems: ["A", "B", "C", "D", "E", "F", "G", "H", "I"] }] } as CvContent;
  act(() => root.render(<CvDraftEditor id="cv-1" content={skillContent} theme={DEFAULT_CV_THEME} librarySkillSections={[{ id: "library-tools", heading: "Tools", items: ["J", "K"] }]} />));
  expect(container.textContent).toContain("9/10 skills");
  expect(container.textContent).toContain("snapshot saved with this CV");
  const picker = container.querySelector<HTMLSelectElement>('[aria-label="Add skill from Library to Tools"]')!;
  act(() => {
    picker.value = "J";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).toContain("10/10 skills");
  expect(picker.disabled).toBe(true);
  expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Add skill")?.disabled).toBe(true);
  const sectionPicker = container.querySelector<HTMLSelectElement>('[aria-label="Add section from Library"]')!;
  act(() => {
    sectionPicker.value = "library-tools";
    sectionPicker.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.querySelector('[name="addedSkills"]')?.getAttribute("value")).toContain('"items":["J","K"]');
});
