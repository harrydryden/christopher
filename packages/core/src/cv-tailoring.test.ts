import { expect, it } from "vitest";
import type { CvRubric } from "./cv-assessment";
import { CvContentSchema, CvPlanSchema, CvStoredPlanSchema, type CvLibrary, type CvPlan } from "./cv";
import { CvTailoringPlanOutputSchema, CvTailoringPlanSchema, cvTailoringEvidence, cvTailoringPlanForWriter, validateCvPlanProvenance, validateCvTailoringPlan, type CvTailoringPlan } from "./cv-tailoring";
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

it("resolves a whole-entry citation only when its quote identifies one confirmed row", () => {
  const sources = cvTailoringEvidence(library);
  const wholeEntry = { ...tailoring, requirements: [
    { ...tailoring.requirements[0]!, evidence: [{ sourceId: "entry:role", quote: "Opened a new sales channel" }] },
    tailoring.requirements[1]!,
  ] };
  expect(validateCvTailoringPlan(wholeEntry, rubric, sources).requirements[0]!.evidence)
    .toEqual([{ sourceId: "entry:role:row:0", quote: "Opened a new sales channel" }]);
  expect(() => validateCvTailoringPlan({ ...wholeEntry, requirements: [
    { ...wholeEntry.requirements[0]!, evidence: [{ sourceId: "entry:role", quote: "new revenue" }] },
    tailoring.requirements[1]!,
  ] }, rubric, sources)).toThrow("Unknown tailoring evidence source");
  const repeated = sources.map(source => source.id === "entry:role:row:1" ? { ...source, text: "Opened a new sales channel and coached six managers" } : source);
  expect(() => validateCvTailoringPlan(wholeEntry, rubric, repeated)).toThrow("Unknown tailoring evidence source");
});

it("gives the writer each verdict and its rows by id, without the planner's reasons or quotes", () => {
  expect(cvTailoringPlanForWriter({ ...tailoring, gapQuestions: [] })).toEqual({ requirements: [
    { requirementId: "r1", status: "demonstrated", evidence: ["entry:role:row:0"] },
    { requirementId: "r2", status: "demonstrated", evidence: ["entry:role:row:1"] },
  ] });
});

it("caps a new plan's reasons below a stored plan's, which keeps reading older, longer ones", () => {
  const long = { ...tailoring, requirements: [{ ...tailoring.requirements[0]!, reason: "x".repeat(400) }, tailoring.requirements[1]!] };
  expect(CvTailoringPlanSchema.safeParse(long).success).toBe(true);
  expect(CvTailoringPlanOutputSchema.safeParse(long).success).toBe(false);
  expect(CvTailoringPlanOutputSchema.safeParse(tailoring).success).toBe(true);
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
  const sourced: CvPlan = { ...legacy, summarySources: ["source:profile"], sections: [{ ...legacy.sections[0]!, bulletSources: [["entry:role:row:0"]] }] };
  expect(validateCvPlanProvenance(sourced, library)).toBe(sourced);
  expect(() => validateCvPlanProvenance({ ...sourced, sections: [{ ...sourced.sections[0]!, bulletSources: [["source:profile"]] }] }, library)).toThrow("another entry");
  expect(() => validateCvPlanProvenance({ ...sourced, sections: [{ ...sourced.sections[0]!, bulletSources: [["entry:role:row:7"]] }] }, library)).toThrow("Unknown CV source");
});

it("checks a citation by the words the bullet shares with the rows it cites, not by a copied quote", () => {
  const plan = (bullet: string, sourceIds: string[]): CvPlan => ({ summary: "Commercial leader", summarySources: ["source:profile"],
    sections: [{ entryId: "role", bullets: [bullet], bulletSources: [sourceIds] }], gaps: [] });
  // A faithful rephrasing keeps the row's words: two shared ("six", "managers").
  expect(() => validateCvPlanProvenance(plan("Helped six managers grow as leaders", ["entry:role:row:1"]), library)).not.toThrow();
  // The same bullet citing the wrong row of its own entry shares nothing with it.
  expect(() => validateCvPlanProvenance(plan("Helped six managers grow as leaders", ["entry:role:row:0"]), library))
    .toThrow("Bullet 1 for role shares too few words with the source rows it cites (entry:role:row:0)");
  // The union of the cited rows counts: one word from each row is two.
  expect(() => validateCvPlanProvenance(plan("Coached sales staff", ["entry:role:row:0", "entry:role:row:1"]), library)).not.toThrow();
  expect(() => validateCvPlanProvenance(plan("Coached sales staff", ["entry:role:row:1"]), library)).toThrow("shares too few words");
  // A profile citing a row it has nothing in common with is refused too.
  expect(() => validateCvPlanProvenance({ ...plan("Coached six managers", ["entry:role:row:1"]), summary: "Seasoned negotiator" }, library))
    .toThrow("The profile shares too few words");
});

it("asks a one-word bullet to share its one word", () => {
  const skills: CvLibrary = { ...library, entries: [...library.entries, { id: "skills", kind: "skill", heading: "Tools", details: "SQL", skillItems: ["SQL"] }] };
  const plan = (bullet: string): CvPlan => ({ summary: "Commercial leader", summarySources: ["source:profile"],
    sections: [{ entryId: "skills", bullets: [bullet], bulletSources: [["entry:skills:skill:0"]] }], gaps: [] });
  expect(() => validateCvPlanProvenance(plan("SQL"), skills)).not.toThrow();
  expect(() => validateCvPlanProvenance(plan("Python"), skills)).toThrow("shares too few words");
});

it("reads a legacy {sourceId, quote} citation as its id, and the writer's schema takes ids alone", () => {
  const legacy = { summary: "Commercial leader", summarySources: [{ sourceId: "source:profile", quote: "Commercial leader" }],
    sections: [{ entryId: "role", bullets: ["Opened a new sales channel"], bulletSources: [[{ sourceId: "entry:role:row:0", quote: "Opened a new sales channel" }]] }], gaps: [] };
  const read = CvStoredPlanSchema.parse(legacy);
  expect(read.summarySources).toEqual(["source:profile"]);
  expect(read.sections[0]!.bulletSources).toEqual([["entry:role:row:0"]]);
  expect(validateCvPlanProvenance(read, library)).toBe(read);
  expect(CvContentSchema.parse({ ...legacy, name: "Example", contact: "", linkedinUrl: "", websiteUrl: "",
    sections: [{ ...legacy.sections[0]!, kind: "experience", heading: "Director" }] }).sections[0]!.bulletSources).toEqual([["entry:role:row:0"]]);
  expect(CvPlanSchema.safeParse(legacy).success).toBe(false);
  expect(CvPlanSchema.safeParse(read).success).toBe(true);
});

it("keeps paraphrased evidence for distinct requirements and drops duplicate keyword coverage", async () => {
  const plan: CvPlan = { summary: "Commercial leader", summarySources: ["source:profile"], sections: [{ entryId: "role", bullets: [
    "Built an additional route to customers.",
    "New market launch and market expansion.",
    "Helped six managers grow as leaders.",
  ], bulletSources: [
    ["entry:role:row:0"],
    ["entry:role:row:0"],
    ["entry:role:row:1"],
  ] }], gaps: [] };
  const budget = { summaryCharacters: 500, totalCharacters: 2000, blocks: [{ entryId: "role", kind: "experience", priority: 1, maxBullets: 2, maxCharacters: 1000, maxBulletCharacters: 500, maxSkills: 0 }] };
  const fitted = await selectCvToFit(library, plan, "new market launch", budget, { plan: tailoring, rubric });
  expect(fitted.plan.sections[0]!.bullets).toEqual(["Built an additional route to customers.", "Helped six managers grow as leaders."]);
  expect(fitted.plan.sections[0]!.bulletSources).toHaveLength(2);
});

it("keeps sole evidence for two essential requirements even when the early bullet cap is one", async () => {
  const plan: CvPlan = { summary: "Commercial leader", summarySources: ["source:profile"], sections: [{ entryId: "role",
    bullets: ["Built another route to customers.", "Helped six managers grow."],
    bulletSources: [["entry:role:row:0"], ["entry:role:row:1"]],
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
    bulletSources: [["entry:role:row:0"], ["entry:role:row:0"], ["entry:role:row:1"]],
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
