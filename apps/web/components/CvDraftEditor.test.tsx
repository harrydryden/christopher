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

it("shows eleven legacy pills as eleven skills, then allows saving after one is removed", () => {
  const labels = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"];
  const legacy = { ...content, sections: [{ entryId: "legacy", kind: "skill", heading: "Tools", bullets: [labels.join(" · ")], bulletSources: [["entry:legacy"]] }] } as CvContent;
  act(() => root.render(<CvDraftEditor id="cv-1" content={legacy} theme={DEFAULT_CV_THEME} />));
  expect(container.textContent).toContain("11/10 skills");
  expect(container.querySelectorAll<HTMLInputElement>('[aria-label^="Skill "][aria-label$="in Tools"]')).toHaveLength(11);
  expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Save Direct Edits")?.disabled).toBe(true);
  expect(container.querySelector('[data-cv-editor-dirty="false"]')).not.toBeNull();
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove skill 11 from Tools"]')!.click());
  expect(container.textContent).toContain("10/10 skills");
  expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Save Direct Edits")?.disabled).toBe(false);
  expect(container.querySelector('[data-cv-editor-dirty="true"]')).not.toBeNull();
});

it("shows each skill's character count and warns without truncating at 150", () => {
  const withSkill = { ...content, sections: [{ entryId: "s-1", kind: "skill", heading: "Tools", bullets: ["SQL"], skillItems: ["SQL"] }] } as CvContent;
  act(() => root.render(<CvDraftEditor id="cv-1" content={withSkill} theme={DEFAULT_CV_THEME} />));
  const skill = container.querySelector<HTMLInputElement>('[aria-label="Skill 1 in Tools"]')!;
  const save = () => [...container.querySelectorAll("button")].find(button => button.textContent === "Save Direct Edits")!;
  expect(skill.hasAttribute("maxlength")).toBe(false);
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(skill, value);
    skill.dispatchEvent(new Event("input", { bubbles: true }));
  });
  type("x".repeat(119));
  expect(container.textContent).toContain("119/150 characters");
  type("x".repeat(120));
  expect(container.textContent).toContain("120/150 characters · Approaching limit");
  type("x".repeat(149));
  expect(save().disabled).toBe(false);
  type("x".repeat(150));
  expect(container.textContent).toContain("150/150 characters · Approaching limit");
  expect(save().disabled).toBe(false);
  type("x".repeat(151));
  expect(skill.value).toHaveLength(151);
  expect(container.textContent).toContain("151/150 characters · Too long");
  expect(save().disabled).toBe(true);
});

it("splits a saved Operations list only after the reviewer asks", () => {
  const combined = "Planning, Delivery, Forecasting, Quality, Service, Reporting";
  const withSkill = { ...content, sections: [{ entryId: "operations", kind: "skill", heading: "Operations", bullets: [combined], skillItems: [combined], bulletSources: [["entry:operations"]] }] } as CvContent;
  act(() => root.render(<CvDraftEditor id="cv-1" content={withSkill} theme={DEFAULT_CV_THEME} />));
  expect(container.textContent).toContain("1/10 skills");
  expect(container.querySelector('[data-cv-editor-dirty="false"]')).not.toBeNull();
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Split skill 1 into separate skills"]')!.click());
  expect(container.textContent).toContain("6/10 skills");
  expect(container.querySelectorAll<HTMLInputElement>('[aria-label^="Skill "][aria-label$="in Operations"]')).toHaveLength(6);
  expect(container.querySelector<HTMLInputElement>('[name="skills-0"]')?.value).toBe("Planning\nDelivery\nForecasting\nQuality\nService\nReporting");
});

it("keeps Library skill pickers within their source sections and splits a copied combined list", () => {
  const combined = "Financial Planning & Analysis, P&L Management, Unit Economics, Product Operations, Customer Success, Customer Support";
  const withSkill = { ...content, sections: [{ entryId: "commercial", kind: "skill", heading: "Commercial", bullets: ["Sales"], skillItems: ["Sales"] }] } as CvContent;
  const sources = [
    { id: "commercial", heading: "Commercial", items: ["Sales", combined] },
    { id: "technology", heading: "Technology", items: ["SQL", "Python"] },
    { id: "operations", heading: "Operations", items: ["Planning", "Delivery"] },
  ];
  act(() => root.render(<CvDraftEditor id="cv-1" content={withSkill} theme={DEFAULT_CV_THEME} librarySkillSections={sources} />));
  const commercialPicker = container.querySelector<HTMLSelectElement>('[aria-label="Add skill from Library to Commercial"]')!;
  expect([...commercialPicker.options].map(option => option.value)).toEqual(["", combined]);
  expect([...commercialPicker.options].map(option => option.value)).not.toContain("SQL");
  const sectionPicker = container.querySelector<HTMLSelectElement>('[aria-label="Add section from Library"]')!;
  act(() => { sectionPicker.value = "technology"; sectionPicker.dispatchEvent(new Event("change", { bubbles: true })); });
  const added = JSON.parse(container.querySelector<HTMLInputElement>('[name="addedSkills"]')!.value);
  expect(added[0]).toMatchObject({ heading: "Technology", items: ["SQL", "Python"], sourceEntryId: "technology" });
  const newSectionPicker = container.querySelector<HTMLSelectElement>('[aria-label="Add skill from Library to new section"]')!;
  expect([...newSectionPicker.options].map(option => option.value)).toEqual([""]);
  act(() => { sectionPicker.value = "commercial"; sectionPicker.dispatchEvent(new Event("change", { bubbles: true })); });
  const split = container.querySelector<HTMLButtonElement>('[aria-label="Split skill 2 in new section into separate skills"]')!;
  act(() => split.click());
  const updated = JSON.parse(container.querySelector<HTMLInputElement>('[name="addedSkills"]')!.value);
  expect(updated[1].items).toEqual(["Sales", "Financial Planning & Analysis", "P&L Management", "Unit Economics", "Product Operations", "Customer Success", "Customer Support"]);
});

it("asks which skills to take from a Library section larger than ten", () => {
  const items = Array.from({ length: 12 }, (_, index) => `Skill ${index + 1}`);
  act(() => root.render(<CvDraftEditor id="cv-1" content={content} theme={DEFAULT_CV_THEME} librarySkillSections={[{ id: "large", heading: "Large", items }]} />));
  const picker = container.querySelector<HTMLSelectElement>('[aria-label="Add section from Library"]')!;
  act(() => { picker.value = "large"; picker.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(container.textContent).toContain("Choose up to 10 skills from Large");
  expect(container.querySelector<HTMLInputElement>('[name="addedSkills"]')?.value).toBe("[]");
  for (const index of [2, 11]) act(() => container.querySelector<HTMLInputElement>(`[aria-label="Select skill ${index + 1} from Large"]`)!.click());
  act(() => [...container.querySelectorAll("button")].find(button => button.textContent === "Add selected Library section")!.click());
  const added = JSON.parse(container.querySelector<HTMLInputElement>('[name="addedSkills"]')!.value);
  expect(added[0]).toMatchObject({ heading: "Large", items: ["Skill 3", "Skill 12"] });
});
