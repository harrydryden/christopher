// @vitest-environment jsdom
/**
 * The CV editor's preview loads the content check on first use. When that chunk cannot be fetched
 * (offline, or a deployment that replaced it), the button must say so, not quietly do nothing.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CV_THEME } from "@col/core/cv-theme-values";
import type { CvContent } from "@col/core/cv";

vi.mock("@/app/actions/cv", () => ({ saveCvDraft: vi.fn(), requestCvSkillSuggestions: vi.fn(), readCvSkillSuggestions: vi.fn() }));
// The lazily loaded check, unreachable: `import("@col/core/cv")` rejects as a failed chunk would.
vi.mock("@col/core/cv", () => { throw new Error("Failed to fetch dynamically imported module"); });

import { CvDraftEditor } from "./CvDraftEditor";
import { readCvSkillSuggestions, requestCvSkillSuggestions, saveCvDraft } from "@/app/actions/cv";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const content = {
  name: "Ada Lovelace", contact: "ada@example.com", summary: "Analyst.", gaps: [],
  sections: [{ entryId: "e-1", kind: "experience", heading: "Analyst, Engines Ltd", bullets: ["Wrote the first program."] }],
} as unknown as CvContent;

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

it("generates skills only on click using current CV edits and saves only selected suggestions", async () => {
  let resolveRequest!: (value: Awaited<ReturnType<typeof requestCvSkillSuggestions>>) => void;
  vi.mocked(requestCvSkillSuggestions).mockReturnValue(new Promise(resolve => { resolveRequest = resolve; }));
  act(() => root.render(<CvDraftEditor id="cv-1" content={content} theme={DEFAULT_CV_THEME}
    baseRevision={3} latestLibraryVersion={7} />));
  expect(requestCvSkillSuggestions).not.toHaveBeenCalled();
  const profile = container.querySelector<HTMLTextAreaElement>('textarea[name="summary"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(profile, " Updated analyst profile. ");
    profile.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const generate = [...container.querySelectorAll("button")].find(button => button.textContent === "Generate skills")!;
  await act(async () => { generate.click(); generate.click(); });
  expect(requestCvSkillSuggestions).toHaveBeenCalledTimes(1);
  expect(requestCvSkillSuggestions).toHaveBeenCalledWith("cv-1", false, 7,
    expect.objectContaining({ summary: "Updated analyst profile." }), 3);
  await act(async () => resolveRequest({ ok: true, run: { id: "run-1", status: "ready", error: null,
    suggestions: [{ id: "proposal-1", category: "Leadership", label: "Team leadership", sourceId: "entry-1",
      evidenceQuote: "Led a team", roleQuote: "Lead a team" },
    { id: "proposal-2", category: "Management", label: "Team management", sourceId: "entry-1",
      evidenceQuote: "Led a team", roleQuote: "Lead a team" }] } }));
  expect(container.textContent).not.toContain("changed after this skill check");
  const selected = [...container.querySelectorAll("label")].find(label => label.textContent?.includes("Team leadership"))!
    .querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  act(() => selected.click());
  expect(container.querySelector<HTMLInputElement>('[name="selectedSuggestionIds"]')?.value).toBe('["proposal-1"]');
  expect(container.textContent).toContain("1 highlighted skill on this CV");
  expect(container.textContent).toContain("1 new skill selected to save · Unsaved.");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(profile, "Another profile revision.");
    profile.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("changed after this skill check");
  expect(container.querySelector<HTMLInputElement>('[name="selectedSuggestionIds"]')?.value).toBe("[]");
  expect(container.textContent).toContain("0 new skills selected to save.");
  expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Save selected skills to CV")?.disabled).toBe(true);
  expect([...container.querySelectorAll("button")].some(button => button.textContent === "Generate skills for current edits")).toBe(true);
});

it("submits selected new skills and other edits through the existing save form, with shared pending and error state", async () => {
  let finishSave!: (value: Awaited<ReturnType<typeof saveCvDraft>>) => void;
  vi.mocked(saveCvDraft).mockReturnValue(new Promise(resolve => { finishSave = resolve; }));
  vi.mocked(requestCvSkillSuggestions).mockResolvedValue({ ok: true, run: { id: "run-1", status: "ready", error: null,
    suggestions: [
      { id: "included", category: "Tools", label: "Python", sourceId: "entry-1", evidenceQuote: "Python", roleQuote: "Python" },
      { id: "new", category: "Leadership", label: "Team leadership", sourceId: "entry-1", evidenceQuote: "Led a team", roleQuote: "Lead a team" },
    ] } });
  const existing = { ...content, sections: [...content.sections, { entryId: "skill-1", kind: "skill", heading: "Tools", bullets: ["Python"], skillItems: ["Python"] }] } as CvContent;
  act(() => root.render(<CvDraftEditor id="cv-1" content={existing} theme={DEFAULT_CV_THEME} baseRevision={3} />));
  const save = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Save selected skills to CV" || button.textContent === "Saving selected skills…")!;
  expect(save().disabled).toBe(true);
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Generate skills")!.click());
  expect(save().disabled).toBe(true);
  const newChoice = [...container.querySelectorAll("label")].find(label => label.textContent?.includes("Team leadership"))!
    .querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  act(() => newChoice.click());
  expect(container.textContent).toContain("1 new skill selected to save · Unsaved.");
  expect(save().disabled).toBe(false);
  const summary = container.querySelector<HTMLTextAreaElement>('textarea[name="summary"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(summary, "Updated analyst profile.");
    summary.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // The changed wording makes the proposal stale; generate it again against these edits.
  expect(save().disabled).toBe(true);
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Generate skills for current edits")!.click());
  act(() => [...container.querySelectorAll("label")].find(label => label.textContent?.includes("Team leadership"))!
    .querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  const form = container.querySelector<HTMLFormElement>("form[id^='cv-edit-']")!;
  expect(save().form).toBe(form);
  act(() => save().click());
  expect(saveCvDraft).toHaveBeenCalledTimes(1);
  const data = vi.mocked(saveCvDraft).mock.calls[0]![2];
  expect(data.get("selectedSuggestionIds")).toBe('["new"]');
  expect(data.get("skillSuggestionRunId")).toBe("run-1");
  expect(data.get("summary")).toBe("Updated analyst profile.");
  expect(save().textContent).toBe("Saving selected skills…");
  expect(save().disabled).toBe(true);
  await act(async () => finishSave({ ok: false, error: "Save was refused." }));
  expect(save().disabled).toBe(false);
  expect(container.textContent).toContain("Save update: Save was refused.");
  expect(form.querySelector('[role="alert"]')?.textContent).toContain("Save was refused.");
});

it("does not let an old poll replace a newer suggestion run", async () => {
  vi.useFakeTimers();
  try {
    let resolveOldPoll!: (value: Awaited<ReturnType<typeof readCvSkillSuggestions>>) => void;
    vi.mocked(readCvSkillSuggestions).mockReturnValue(new Promise(resolve => { resolveOldPoll = resolve; }));
    vi.mocked(requestCvSkillSuggestions)
      .mockResolvedValueOnce({ ok: true, run: { id: "old-run", status: "queued", suggestions: [], error: null } })
      .mockResolvedValueOnce({ ok: true, run: { id: "new-run", status: "ready", error: null,
        suggestions: [{ id: "new-skill", category: "Leadership", label: "Team leadership", sourceId: "entry-1",
          evidenceQuote: "Led a team", roleQuote: "Lead a team" }] } });
    act(() => root.render(<CvDraftEditor id="cv-1" content={content} theme={DEFAULT_CV_THEME} baseRevision={1} />));
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Generate skills")!.click());
    await act(async () => { vi.advanceTimersByTime(3_000); });
    expect(readCvSkillSuggestions).toHaveBeenCalledWith("cv-1", "old-run");
    const profile = container.querySelector<HTMLTextAreaElement>('textarea[name="summary"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(profile, "Updated analyst profile.");
      profile.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Generate skills for current edits")!.click());
    await act(async () => resolveOldPoll({ ok: true, run: { id: "old-run", status: "ready", suggestions: [], error: null } }));
    expect(container.textContent).toContain("Team leadership");
    expect(container.querySelector<HTMLInputElement>('[name="skillSuggestionRunId"]')?.value).toBe("new-run");
  } finally {
    vi.useRealTimers();
  }
});

it("offers a fresh generation after server rejection, but reconnects after an unknown network outcome", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(requestCvSkillSuggestions).mockResolvedValue({ ok: true,
      run: { id: "queued-run", status: "queued", suggestions: [], error: null } });
    vi.mocked(readCvSkillSuggestions)
      .mockResolvedValueOnce({ ok: false, error: "Your CV changed. Generate skills again." })
      .mockRejectedValueOnce(new Error("network disconnected"))
      .mockResolvedValueOnce({ ok: true, run: { id: "queued-run", status: "ready", suggestions: [], error: null } });
    act(() => root.render(<CvDraftEditor id="cv-1" content={content} theme={DEFAULT_CV_THEME} baseRevision={1} />));
    const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label)!;
    await act(async () => button("Generate skills").click());
    await act(async () => { vi.advanceTimersByTime(3_000); });
    expect(container.textContent).toContain("Your CV changed. Generate skills again.");
    expect(button("Generate skills")).not.toBeNull();
    await act(async () => button("Generate skills").click());
    expect(requestCvSkillSuggestions).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(3_000); });
    expect(button("Reconnect to suggestion check")).not.toBeNull();
    await act(async () => button("Reconnect to suggestion check").click());
    expect(readCvSkillSuggestions).toHaveBeenCalledTimes(3);
    expect(requestCvSkillSuggestions).toHaveBeenCalledTimes(2);
    expect(button("Refresh suggestions")).not.toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("keeps the server-rendered editor disabled until hydration enables its handlers", () => {
  const props = { id: "cv-1", content, theme: DEFAULT_CV_THEME,
    librarySkillSections: [{ id: "saved-tools", heading: "Tools", items: ["Python"] }] };
  const html = renderToString(<CvDraftEditor {...props} />);
  expect(html).toContain('data-cv-editor-ready="false"');
  expect(html).toMatch(/<fieldset[^>]*disabled=""/);
  const server = document.createElement("div");
  server.innerHTML = html;
  expect(server.querySelector<HTMLTextAreaElement>('textarea[name="summary"]')?.matches(":disabled")).toBe(true);
  expect(server.querySelector<HTMLSelectElement>('[aria-label="Add section from Experience"]')?.matches(":disabled")).toBe(true);
  act(() => root.render(<CvDraftEditor {...props} />));
  const fieldset = container.querySelector<HTMLFieldSetElement>('[data-cv-editor-ready="true"]');
  expect(fieldset?.disabled).toBe(false);
  expect(container.querySelector<HTMLTextAreaElement>('textarea[name="summary"]')?.matches(":disabled")).toBe(false);
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Add section from Experience"]')?.matches(":disabled")).toBe(false);
});

it("blocks edits for an unverified account without disabling read-only share controls", () => {
  act(() => root.render(<CvDraftEditor id="cv-1" content={content} theme={DEFAULT_CV_THEME}
    blocked="Confirm your account" share={<button type="button" data-share-control>Share details</button>} />));
  expect(container.querySelector<HTMLTextAreaElement>('textarea[name="summary"]')?.matches(":disabled")).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[data-share-control]')?.matches(":disabled")).toBe(false);
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
  act(() => root.render(<CvDraftEditor id="cv-1" content={content} theme={DEFAULT_CV_THEME}
    librarySkillSections={[{ id: "saved-tools", heading: "Tools", items: ["Python"] }]} />));
  const button = (label: string) => [...container.querySelectorAll("button")].find((element) => element.textContent === label)!;
  const picker = container.querySelector<HTMLSelectElement>('[aria-label="Add section from Experience"]')!;
  act(() => { picker.value = "saved-tools"; picker.dispatchEvent(new Event("change", { bubbles: true })); });
  const skill = container.querySelector<HTMLInputElement>('[aria-label="Skill 1 in new section"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(skill, "Python");
    skill.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelector('[name="addedSkills"]')?.getAttribute("value")).toContain('"sourceEntryId":"saved-tools"');
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
  const picker = container.querySelector<HTMLSelectElement>('[aria-label="Add skill from Experience to Tools"]')!;
  act(() => {
    picker.value = "J";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).toContain("10/10 skills");
  expect(picker.disabled).toBe(true);
  expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Add skill")?.disabled).toBe(true);
  const sectionPicker = container.querySelector<HTMLSelectElement>('[aria-label="Add section from Experience"]')!;
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
  expect([...container.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Save "))?.disabled).toBe(true);
  expect(container.querySelector('[data-cv-editor-dirty="false"]')).not.toBeNull();
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove skill 11 from Tools"]')!.click());
  expect(container.textContent).toContain("10/10 skills");
  expect([...container.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Save "))?.disabled).toBe(false);
  expect(container.querySelector('[data-cv-editor-dirty="true"]')).not.toBeNull();
});

it("shows each skill's character count and warns without truncating at 150", () => {
  const withSkill = { ...content, sections: [{ entryId: "s-1", kind: "skill", heading: "Tools", bullets: ["SQL"], skillItems: ["SQL"] }] } as CvContent;
  act(() => root.render(<CvDraftEditor id="cv-1" content={withSkill} theme={DEFAULT_CV_THEME} />));
  const skill = container.querySelector<HTMLInputElement>('[aria-label="Skill 1 in Tools"]')!;
  const save = () => [...container.querySelectorAll("button")].find(button => button.textContent?.startsWith("Save "))!;
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
  const commercialPicker = container.querySelector<HTMLSelectElement>('[aria-label="Add skill from Experience to Commercial"]')!;
  expect([...commercialPicker.options].map(option => option.value)).toEqual(["", combined]);
  expect([...commercialPicker.options].map(option => option.value)).not.toContain("SQL");
  const sectionPicker = container.querySelector<HTMLSelectElement>('[aria-label="Add section from Experience"]')!;
  act(() => { sectionPicker.value = "technology"; sectionPicker.dispatchEvent(new Event("change", { bubbles: true })); });
  const added = JSON.parse(container.querySelector<HTMLInputElement>('[name="addedSkills"]')!.value);
  expect(added[0]).toMatchObject({ heading: "Technology", items: ["SQL", "Python"], sourceEntryId: "technology" });
  const newSectionPicker = container.querySelector<HTMLSelectElement>('[aria-label="Add skill from Experience to new section"]')!;
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
  const picker = container.querySelector<HTMLSelectElement>('[aria-label="Add section from Experience"]')!;
  act(() => { picker.value = "large"; picker.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(container.textContent).toContain("Choose up to 10 skills from Large");
  expect(container.querySelector<HTMLInputElement>('[name="addedSkills"]')?.value).toBe("[]");
  for (const index of [2, 11]) act(() => container.querySelector<HTMLInputElement>(`[aria-label="Select skill ${index + 1}: Skill ${index + 1} from Large"]`)!.click());
  expect(container.querySelector('[aria-label="Select skill 3: Skill 3 from Large"]')).not.toBeNull();
  act(() => [...container.querySelectorAll("button")].find(button => button.textContent === "Add selected Experience section")!.click());
  const added = JSON.parse(container.querySelector<HTMLInputElement>('[name="addedSkills"]')!.value);
  expect(added[0]).toMatchObject({ heading: "Large", items: ["Skill 3", "Skill 12"] });
});
