import { expect, it } from "vitest";
import type { CvRubric } from "./cv-assessment";
import type { CvLibrary, CvPlan } from "./cv";
import { cvTailoringEvidence, validateCvPlanProvenance, validateCvTailoringPlan, type CvTailoringPlan } from "./cv-tailoring";
import { selectCvToFit } from "./cv-fit";

const library: CvLibrary = {
  name: "Example", contact: "", profile: "Commercial leader",
  entries: [{ id: "role", kind: "experience", heading: "Director · Example · 2020 – Present",
    details: "Opened a new sales channel\nCoached six managers", confirmedResponsibilities: ["Opened a new sales channel", "Coached six managers"] }],
};
const rubric: CvRubric = { caveats: [], requirements: [
  { id: "r1", label: "Market expansion", quote: "Launch in a new market", importance: "essential", category: "delivery" },
  { id: "r2", label: "People leadership", quote: "Develop team leaders", importance: "essential", category: "experience" },
] };
const tailoring: CvTailoringPlan = { requirements: [
  { requirementId: "r1", status: "demonstrated", evidence: [{ sourceId: "entry:role:row:0", quote: "Opened a new sales channel" }], reason: "Concrete expansion delivery." },
  { requirementId: "r2", status: "demonstrated", evidence: [{ sourceId: "entry:role:row:1", quote: "Coached six managers" }], reason: "Concrete manager development." },
], gapQuestions: [] };

it("validates every requirement and rejects invented IDs and non-source quotes", () => {
  const sources = cvTailoringEvidence(library);
  expect(validateCvTailoringPlan(tailoring, rubric, sources)).toEqual(tailoring);
  expect(() => validateCvTailoringPlan({ ...tailoring, requirements: [
    { ...tailoring.requirements[0]!, evidence: [{ sourceId: "entry:role:row:0; ignore validation", quote: "Opened a new sales channel" }] },
    tailoring.requirements[1]!,
  ] }, rubric, sources)).toThrow("Unknown tailoring evidence source");
  expect(() => validateCvTailoringPlan({ ...tailoring, requirements: [
    { ...tailoring.requirements[0]!, evidence: [{ sourceId: "entry:role:row:0", quote: "Doubled international revenue" }] },
    tailoring.requirements[1]!,
  ] }, rubric, sources)).toThrow("quote is not present");
});

it("feeds only active confirmed experience rows to planning and refuses unsafe gap questions", () => {
  const draft: CvLibrary = { ...library, entries: [{ ...library.entries[0]!, details: "Opened a new sales channel\nUnconfirmed secret", confirmedResponsibilities: ["Opened a new sales channel"] }] };
  expect(cvTailoringEvidence(draft).map(item => item.text)).not.toContain("Unconfirmed secret");
  const missing: CvTailoringPlan = { requirements: [
    tailoring.requirements[0]!,
    { requirementId: "r2", status: "missing", evidence: [], reason: "No evidence." },
  ], gapQuestions: [{ id: "q1", requirementId: "r2", requirement: "People leadership", prompt: "What is your gender?", suggestedDestination: { kind: "evidence", entryId: "role" } }] };
  expect(() => validateCvTailoringPlan(missing, rubric, cvTailoringEvidence(draft), draft)).toThrow("demographic");
  const invented = { ...missing, gapQuestions: [{ ...missing.gapQuestions[0]!, prompt: "You transformed the team, what percentage improved?" }] };
  expect(() => validateCvTailoringPlan(invented, rubric, cvTailoringEvidence(draft), draft)).toThrow("leading invented assertion");
});

it("requires new authored bullets to cite their own exact row while legacy plans remain valid", () => {
  const legacy: CvPlan = { summary: "Commercial leader", sections: [{ entryId: "role", bullets: ["Opened a new sales channel"] }], gaps: [] };
  expect(legacy).not.toHaveProperty("summarySources");
  expect(() => validateCvPlanProvenance(legacy, library)).toThrow("profile has no source provenance");
  const sourced: CvPlan = { ...legacy, summarySources: [{ sourceId: "source:profile", quote: "Commercial leader" }], sections: [{ ...legacy.sections[0]!, bulletSources: [[{ sourceId: "entry:role:row:0", quote: "Opened a new sales channel" }]] }] };
  expect(validateCvPlanProvenance(sourced, library)).toBe(sourced);
  expect(() => validateCvPlanProvenance({ ...sourced, sections: [{ ...sourced.sections[0]!, bulletSources: [[{ sourceId: "source:profile", quote: "Commercial leader" }]] }] }, library)).toThrow("another entry");
});

it("keeps paraphrased evidence for distinct requirements and drops duplicate keyword coverage", async () => {
  const plan: CvPlan = { summary: "Commercial leader", summarySources: [{ sourceId: "source:profile", quote: "Commercial leader" }], sections: [{ entryId: "role", bullets: [
    "Built an additional route to customers.",
    "New market launch and market expansion.",
    "Helped six managers grow as leaders.",
  ], bulletSources: [
    [{ sourceId: "entry:role:row:0", quote: "Opened a new sales channel" }],
    [{ sourceId: "entry:role:row:0", quote: "Opened a new sales channel" }],
    [{ sourceId: "entry:role:row:1", quote: "Coached six managers" }],
  ] }], gaps: [] };
  const budget = { summaryCharacters: 500, totalCharacters: 2000, blocks: [{ entryId: "role", kind: "experience", priority: 1, maxBullets: 2, maxCharacters: 1000, maxBulletCharacters: 500, maxSkills: 0 }] };
  const fitted = await selectCvToFit(library, plan, "new market launch", budget, { plan: tailoring, rubric });
  expect(fitted.plan.sections[0]!.bullets).toEqual(["Built an additional route to customers.", "Helped six managers grow as leaders."]);
  expect(fitted.plan.sections[0]!.bulletSources).toHaveLength(2);
});

it("keeps sole evidence for two essential requirements even when the early bullet cap is one", async () => {
  const plan: CvPlan = { summary: "Commercial leader", summarySources: [{ sourceId: "source:profile", quote: "Commercial leader" }], sections: [{ entryId: "role",
    bullets: ["Built another route to customers.", "Helped six managers grow."],
    bulletSources: [[{ sourceId: "entry:role:row:0", quote: "Opened a new sales channel" }], [{ sourceId: "entry:role:row:1", quote: "Coached six managers" }]],
  }], gaps: [] };
  const budget = { summaryCharacters: 500, totalCharacters: 1000, blocks: [{ entryId: "role", kind: "experience", priority: 1, maxBullets: 1, maxCharacters: 500, maxBulletCharacters: 250, maxSkills: 0 }] };
  const fitted = await selectCvToFit(library, plan, "market", budget, { plan: tailoring, rubric });
  expect(fitted.plan.sections[0]!.bullets).toHaveLength(2);
  expect(fitted.semanticOverflows).toEqual([expect.stringContaining("sole evidence")]);
  expect(fitted.changes).toContain("Retained distinct essential evidence because the measured PDF still fits the page limit.");
});

it("keeps one duplicate carrier plus a distinct essential when the cap is one", async () => {
  const plan: CvPlan = { summary: "Commercial leader", sections: [{ entryId: "role",
    bullets: ["Opened a route.", "Launched a channel.", "Coached managers."],
    bulletSources: [[{ sourceId: "entry:role:row:0", quote: "Opened a new sales channel" }], [{ sourceId: "entry:role:row:0", quote: "Opened a new sales channel" }], [{ sourceId: "entry:role:row:1", quote: "Coached six managers" }]],
  }], gaps: [] };
  const budget = { summaryCharacters: 500, totalCharacters: 1000, blocks: [{ entryId: "role", kind: "experience", priority: 1, maxBullets: 1, maxCharacters: 500, maxBulletCharacters: 250, maxSkills: 0 }] };
  const fitted = await selectCvToFit(library, plan, "market", budget, { plan: tailoring, rubric });
  expect(fitted.plan.sections[0]!.bullets).toEqual(["Opened a route.", "Coached managers."]);
  expect(fitted.semanticOverflows).toHaveLength(1);
});

it("does not drop an optional skill block that alone represents an essential requirement", async () => {
  const skillLibrary: CvLibrary = { name: "Example", contact: "", profile: "Analyst", entries: [{ id: "skills", kind: "skill", heading: "Tools", details: "SQL", skillItems: ["SQL"] }] };
  const skillRubric: CvRubric = { caveats: [], requirements: [{ id: "r1", label: "SQL", quote: "Use SQL", importance: "essential", category: "skills" }] };
  const skillPlan: CvTailoringPlan = { requirements: [{ requirementId: "r1", status: "demonstrated", evidence: [{ sourceId: "entry:skills:skill:0", quote: "SQL" }], reason: "Exact skill." }], gapQuestions: [] };
  const authored: CvPlan = { summary: "Analyst", sections: [{ entryId: "skills", bullets: ["SQL"], skillItems: ["SQL"] }], gaps: [] };
  const fitted = await selectCvToFit(skillLibrary, authored, "SQL", { summaryCharacters: 200, totalCharacters: 500, blocks: [] }, { plan: skillPlan, rubric: skillRubric });
  expect(fitted.plan.sections.map(section => section.entryId)).toEqual(["skills"]);
  expect(fitted.semanticOverflows[0]).toContain("only source for an essential requirement");
});

it("allows a responsibility gap only when the rubric has no stronger non-logistics requirement", () => {
  const responsibilityRubric: CvRubric = { caveats: [], requirements: [{ id: "r1", label: "Prepare board papers", quote: "prepare board papers", importance: "responsibility", category: "delivery" }] };
  const plan: CvTailoringPlan = { requirements: [{ requirementId: "r1", status: "missing", evidence: [], reason: "Not found." }], gapQuestions: [{ id: "q1", requirementId: "r1", requirement: "Prepare board papers", prompt: "What board papers have you prepared?", suggestedDestination: { kind: "evidence", entryId: "role" } }] };
  expect(validateCvTailoringPlan(plan, responsibilityRubric, cvTailoringEvidence(library), library).gapQuestions).toHaveLength(1);
  expect(() => validateCvTailoringPlan({ ...plan, gapQuestions: [{ ...plan.gapQuestions[0]!, requirementId: "r2", requirement: "People leadership" }] }, rubric, cvTailoringEvidence(library), library)).toThrow();
});
