import { expect, it } from "vitest";
import { materialiseCv, type CvContent, type CvLibrary, type CvPlan } from "./cv";
import { renderCvPdfWithReport } from "./cv-pdf";
import { createCvWritingBudget } from "./cv-budget";
import { selectCvToFit } from "./cv-fit";
import { cvOrderedSkillLibrary, cvOrderedSkillPlan, cvSkillOrderHint, cvValidSkillOrderHint } from "./cv-skill-order";
import { readCvBuildCheckpoint } from "./cv-build";

const library = { name: "Example", contact: "London", profile: "", entries: [
  { id: "role", kind: "experience", heading: "Role", details: "Led delivery", confirmedResponsibilities: ["Led delivery"] },
  { id: "skills-a", kind: "skill", heading: "Tools", details: "", skillItems: ["A", "B", "C"] },
  { id: "training", kind: "training", heading: "Training", details: "Course" },
  { id: "skills-b", kind: "skill", heading: "Methods", details: "", skillItems: ["D"] },
] } as CvLibrary;

it("uses a validated CV's skill order without moving employment or training in the working Library", () => {
  const content = { sections: [
    { entryId: "role", kind: "experience", heading: "Role", bullets: ["Led delivery"] },
    { entryId: "skills-b", kind: "skill", heading: "Methods", bullets: ["D"], skillItems: ["D"] },
    { entryId: "skills-a", kind: "skill", heading: "Tools", bullets: ["B", "A"], skillItems: ["B", "A"] },
  ] } as CvContent;
  const hint = cvSkillOrderHint(content);
  const working = cvOrderedSkillLibrary(library, hint);
  expect(working.entries.map(entry => entry.id)).toEqual(["role", "skills-b", "training", "skills-a"]);
  expect(library.entries.map(entry => entry.id)).toEqual(["role", "skills-a", "training", "skills-b"]);
  expect(hint).toEqual([{ entryId: "skills-b", items: ["D"] }, { entryId: "skills-a", items: ["B", "A"] }]);
});

it("retains valid legacy skill lists and task intent across a prompt-set checkpoint reset", () => {
  const legacy = [{ entryId: "s".repeat(150), items: Array.from({ length: 11 }, (_, index) => `Skill ${index}`) }];
  expect(cvValidSkillOrderHint(legacy)).toEqual(legacy);
  expect(cvValidSkillOrderHint([{ ...legacy[0], items: [...legacy[0]!.items, ...Array(10).fill("extra")] }])).toBeUndefined();
  expect(cvValidSkillOrderHint([...legacy, legacy[0]])).toBeUndefined();
  expect(readCvBuildCheckpoint({ v: 2, promptSetVersion: "older", stages: {}, mode: "improve", skillOrder: legacy }, "newer")
    .checkpoint.skillOrder).toEqual(legacy);
});

it("orders only selected authored labels and appends new selections without restoring omitted skills", () => {
  const plan = { summary: "Leader", gaps: [], sections: [
    { entryId: "skills-a", skillItems: ["C", "A"], bullets: ["C", "A"],
      bulletSources: [["entry:skills-a:row:2"], ["entry:skills-a:row:0"]] },
    { entryId: "role", bullets: ["Led delivery"] },
  ] } as CvPlan;
  const ordered = cvOrderedSkillPlan(plan, [{ entryId: "skills-a", items: ["B", "A"] },
    { entryId: "absent", items: ["D"] }]);
  expect(ordered.sections[0]).toMatchObject({ skillItems: ["A", "C"], bullets: ["C", "A"],
    bulletSources: [["entry:skills-a:row:2"], ["entry:skills-a:row:0"]] });
  expect(ordered.sections[1]).toBe(plan.sections[1]);
  expect(plan.sections[0]?.skillItems).toEqual(["C", "A"]);
  expect(ordered.sections.flatMap(section => section.skillItems ?? [])).not.toContain("B");
});

it("measures and renders the selected Rewrite order while leaving more than six cited bullets aligned", async () => {
  const many = Array.from({ length: 8 }, (_, index) => `Skill ${index + 1}`);
  const source = { ...library, entries: library.entries.map(entry => entry.id === "skills-a"
    ? { ...entry, skillItems: many } : entry) } as CvLibrary;
  const hint = [{ entryId: "skills-b", items: ["D"] }, { entryId: "skills-a", items: ["Skill 8", "Skill 1"] }];
  const plan = { summary: "Leader", gaps: [], sections: [
    { entryId: "role", bullets: ["Led delivery"] },
    { entryId: "skills-a", skillItems: many, bullets: many.slice(0, 6),
      bulletSources: many.slice(0, 6).map((_, index) => [`entry:skills-a:row:${index}`]) },
    { entryId: "skills-b", skillItems: ["D"], bullets: ["D"] },
  ] } as CvPlan;
  const ordered = cvOrderedSkillPlan(plan, hint);
  expect(ordered.sections[1]?.skillItems?.[0]).toBe("Skill 8");
  expect(ordered.sections[1]?.bullets).toEqual(many.slice(0, 6));
  expect(ordered.sections[1]?.bulletSources).toEqual(plan.sections[1]?.bulletSources);
  const working = cvOrderedSkillLibrary(source, hint);
  const content = materialiseCv(working, ordered);
  expect(content.sections.map(section => section.entryId)).toEqual(["role", "skills-b", "skills-a"]);
  expect(content.sections[2]?.skillItems?.[0]).toBe("Skill 8");
  expect((await renderCvPdfWithReport(content)).pageCount).toBeGreaterThan(0);
  const target = "Led delivery D Skill 1 Skill 2 Skill 3 Skill 4 Skill 5 Skill 6 Skill 7 Skill 8";
  const fitted = await selectCvToFit(working, ordered, target, createCvWritingBudget(working, target));
  expect(fitted.content.sections.filter(section => section.kind === "skill").map(section => section.entryId))
    .toEqual(["skills-b", "skills-a"]);
});
