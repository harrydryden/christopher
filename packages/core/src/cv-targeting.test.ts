import { describe, expect, it } from "vitest";
import { CvContentSchema, DEFAULT_CV_THEME, type CvLibrary } from "./cv";
import { CvTargetingBriefSchema, cvEssentialOmissionIds, cvMappedEssentialOmissionIds, cvEligibleSkillLibrary, cvSkillSourcePolicy,
  cvTargetedSummaryFinalisationIssue, cvEffectiveRubric, validateCvEffectiveRubric, projectCvTargetedContent,
  projectCvWritingLibrary, projectCvWritingPlan, validateCvTargetingEntries, cvRankedPriorityChoices,
  cvRecommendedPriorityOrder, cvRecommendedPriorityIds, cvPriorityMappingIdentity } from "./cv-targeting";
import { cvRequirementWeight, type CvRubric } from "./cv-assessment";
import type { CvTailoringPlan } from "./cv-tailoring";
import { createCvWritingBudget, cvRelevanceTerms } from "./cv-budget";
import { cvSkillEvidenceRows, cvSkillSuggestionInputHash } from "./cv-skill-suggestions";
import { cvSkillDraftContext } from "./cv-skill-draft-context";

const source = { libraryVersion: 1, evidenceHash: "a".repeat(64), jobDescriptionHash: "b".repeat(64) };
const rubric: CvRubric = { requirements: [
  { id: "r1", label: "Own delivery", quote: "Own delivery", importance: "essential", category: "delivery" },
], caveats: [] };
const priority = { state: "confirmed" as const, rubric, rubricKey: "c".repeat(64),
  emphasisRequirementIds: ["r1"], acknowledgedEssentialOmissionIds: [] };
const brief = (entries: Array<{ entryId: string; treatment: "feature" | "summarise" | "omit" }>, manualSections?: ReturnType<typeof CvContentSchema.parse>["sections"]) =>
  CvTargetingBriefSchema.parse({ version: 1, source, entries, presentation: { maxPages: 2, bodySizePt: 12 }, priority, manualSections });
const content = CvContentSchema.parse({ name: "Test", contact: "test@example.com", summary: "Led supported delivery",
  summarySources: ["entry:one:row:0"], sections: [
    { entryId: "one", kind: "experience", heading: "First role", bullets: ["Led delivery", "Improved handover"],
      bulletSources: [["entry:one:row:0"], ["entry:one:row:1"]] },
    { entryId: "two", kind: "experience", heading: "Second role", bullets: ["Managed testing"] },
  ], gaps: [] });

describe("CV targeting", () => {
  it("keeps role quotations and user provenance through a ranked rubric JSON round-trip", () => {
    const rows = [
      { id: "u:00000000-0000-4000-8000-000000000001", text: "Regional delivery", essential: true },
      { id: "r1", text: "Lead programmes", essential: false },
    ];
    const effective = cvEffectiveRubric(rubric, rows);
    expect(effective.requirements.map(item => [item.id, item.rank, item.origin])).toEqual([
      [rows[0]!.id, 1, "user"], ["r1", 2, "role"],
    ]);
    expect(effective.requirements[0]).toMatchObject({ label: "Regional delivery", quote: "Regional delivery", customised: true });
    expect(effective.requirements[1]).toMatchObject({ label: "Lead programmes", quote: "Own delivery", customised: true });
    expect(validateCvEffectiveRubric(rubric, rows, JSON.parse(JSON.stringify(effective)))).toEqual(effective);
    expect(() => validateCvEffectiveRubric(rubric, rows, { ...effective,
      requirements: effective.requirements.map(item => item.id === "r1" ? { ...item, quote: "Invented employer quote" } : item) }))
      .toThrow(/original role rubric/);
    expect(cvRequirementWeight(effective.requirements[0]!)).toBeGreaterThan(cvRequirementWeight({ ...effective.requirements[0]!, rank: 2 }));
    expect(cvRequirementWeight(rubric.requirements[0]!)).toBe(2);
    const terms = cvRelevanceTerms(effective.requirements);
    expect(terms.get("programmes")).toBeGreaterThan(0);
    expect(terms.has("own")).toBe(false);
    expect(terms.has("regional")).toBe(true);
  });
  it("reuses an evidence map for rank and essential edits, but not changed criterion meaning", () => {
    const mapped = cvEffectiveRubric(rubric, [{ id: "r1", text: "Own delivery", essential: false }]);
    const plan: CvTailoringPlan = { requirements: [{ requirementId: "r1", status: "demonstrated",
      evidence: [{ sourceId: "entry:one:row:0", quote: "Led delivery" }], reason: "Direct evidence" }], gapQuestions: [] };
    const writing = { name: "Test", contact: "", profile: "", entries: [] } as CvLibrary;
    const promoted = cvEffectiveRubric(rubric, [{ id: "r1", text: "Own delivery", essential: true }]);
    expect(cvMappedEssentialOmissionIds(plan, mapped, promoted, writing)).toEqual(["r1"]);
    const reranked = cvEffectiveRubric(rubric, [{ id: "r1", text: "Own delivery", essential: false }]);
    expect(cvMappedEssentialOmissionIds(plan, mapped, reranked, writing)).toEqual([]);
    const reworded = cvEffectiveRubric(rubric, [{ id: "r1", text: "Lead programmes", essential: true }]);
    expect(cvMappedEssentialOmissionIds(plan, mapped, reworded, writing)).toEqual([]);
  });
  it("validates bounded, attributed user criteria before they can become an effective rubric", () => {
    const userId = "u:00000000-0000-4000-8000-000000000001";
    const original = { id: "r1", text: "Own delivery", essential: true };
    const valid = { id: userId, text: "Lead colleagues", essential: false };
    expect(cvRankedPriorityChoices(rubric, [original, valid])).toHaveLength(2);
    expect(() => cvRankedPriorityChoices(rubric, [original, original])).toThrow();
    expect(() => cvRankedPriorityChoices(rubric, [{ ...original, text: "  " }])).toThrow();
    expect(() => cvRankedPriorityChoices(rubric, [{ ...original, id: "foreign-role" }])).toThrow(/stable identifier/);
    expect(() => cvRankedPriorityChoices(rubric, [{ ...valid, id: "u:invented" }])).toThrow(/stable identifier/);
    expect(() => cvRankedPriorityChoices(rubric, [{ ...valid, text: "Gender only" }])).toThrow(/Demographic/);
    expect(() => cvRankedPriorityChoices(rubric, Array.from({ length: 31 }, (_, i) => ({
      id: `u:00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      text: `Criterion ${i}`, essential: false })))).toThrow();
  });
  it("lets explicit rank govern scoring and allocation independently of essential status", () => {
    const sourceRubric: CvRubric = { requirements: [rubric.requirements[0]!,
      { id: "r2", label: "People leadership", quote: "People leadership", importance: "desirable", category: "delivery" }], caveats: [] };
    const first = cvEffectiveRubric(sourceRubric, [
      { id: "r2", text: "People leadership", essential: false },
      { id: "r1", text: "Own delivery", essential: true },
    ]);
    const reversed = cvEffectiveRubric(sourceRubric, [
      { id: "r1", text: "Own delivery", essential: true },
      { id: "r2", text: "People leadership", essential: false },
    ]);
    expect(cvRequirementWeight(first.requirements[0]!)).toBeGreaterThan(cvRequirementWeight(first.requirements[1]!));
    expect(cvRequirementWeight(reversed.requirements[0]!)).toBeGreaterThan(cvRequirementWeight(reversed.requirements[1]!));
    const terms = cvRelevanceTerms(first.requirements);
    expect(terms.get("people") ?? 0).toBeGreaterThan(terms.get("own") ?? 0);
    const reversedTerms = cvRelevanceTerms(reversed.requirements);
    expect(reversedTerms.get("own") ?? 0).toBeGreaterThan(reversedTerms.get("people") ?? 0);
    const rows = [{ id: "r1", text: "Own delivery", essential: true },
      { id: "r2", text: "People leadership", essential: false }];
    expect(cvPriorityMappingIdentity(rows)).toBe(cvPriorityMappingIdentity([
      { ...rows[1]!, essential: true }, { ...rows[0]!, essential: false },
    ]));
    expect(cvPriorityMappingIdentity(rows)).not.toBe(cvPriorityMappingIdentity([
      rows[0]!, { ...rows[1]!, text: "Regional strategy" },
    ]));
  });
  it("orders all initial role criteria by the existing recommendation score with stable ties", () => {
    const initial: CvRubric = { requirements: [
      { id: "logistics", label: "Travel", quote: "Travel", importance: "essential", category: "logistics" },
      { id: "delivery-a", label: "Deliver", quote: "Deliver", importance: "desirable", category: "delivery" },
      { id: "essential-a", label: "Lead", quote: "Lead", importance: "essential", category: "delivery" },
      { id: "delivery-b", label: "Improve", quote: "Improve", importance: "desirable", category: "delivery" },
    ], caveats: [] };
    expect(cvRecommendedPriorityOrder(initial)).toEqual(["essential-a", "delivery-a", "delivery-b", "logistics"]);
    expect(cvRecommendedPriorityIds(initial)).toEqual(cvRecommendedPriorityOrder(initial));
  });
  it("restores all manual wording after Feature → Summarise → Feature and keeps first-bullet edits", () => {
    const summarised = projectCvTargetedContent(content, brief([{ entryId: "one", treatment: "summarise" }]));
    expect(summarised.content.sections[0]?.bullets).toEqual(["Led delivery"]);
    const edited = { ...summarised.content, sections: summarised.content.sections.map(section => section.entryId === "one"
      ? { ...section, bullets: ["Led a supported project"] } : section) };
    const previous = brief([{ entryId: "one", treatment: "summarise" }], summarised.manualSections);
    const featured = projectCvTargetedContent(edited, brief([{ entryId: "one", treatment: "feature" }]), previous);
    expect(featured.content.sections[0]?.bullets).toEqual(["Led a supported project", "Improved handover"]);
    expect(featured.content.sections[0]?.bulletSources?.[1]).toEqual(["entry:one:row:1"]);
  });

  it("retains newly added sections and resolves a missing legacy theme", () => {
    const added = { ...content, sections: [...content.sections, { entryId: "three", kind: "training" as const,
      heading: "Training", bullets: ["Completed course"] }] };
    const projected = projectCvTargetedContent(added, brief([{ entryId: "one", treatment: "omit" }]));
    expect(projected.content.sections.map(section => section.entryId)).toEqual(["two", "three"]);
    expect(projected.content.theme?.bodySizePt).toBe(12);
    expect(projected.content.theme?.maxPages).toBe(2);
    expect(projected.summaryNeedsReview).toBe(true);
  });

  it("does not resurrect a supporting section the editor deliberately removed", () => {
    const previous = brief([], content.sections);
    const withoutSecond = { ...content, sections: content.sections.filter(section => section.entryId !== "two") };
    const projected = projectCvTargetedContent(withoutSecond, brief([]), previous);
    expect(projected.content.sections.map(section => section.entryId)).toEqual(["one"]);
    expect(projected.manualSections.map(section => section.entryId)).toEqual(["one"]);
  });

  it("keeps original evidence row IDs while projecting sole essential coverage", () => {
    const library = { name: "Test", contact: "", profile: "", structuredExperience: true as const,
      employment: [{ id: "job", company: "A", jobTitle: "Manager", startDate: "2020", endDate: "2022", current: false }],
      entries: [{ id: "one", kind: "experience" as const, heading: "Manager", details: "Led delivery\nImproved handover",
        employmentId: "job", confirmedResponsibilities: ["Led delivery", "Improved handover"] },
        { id: "two", kind: "training" as const, heading: "Training", details: "Completed course" }] } as CvLibrary;
    const fullPlan: CvTailoringPlan = { requirements: [{ requirementId: "r1", status: "demonstrated",
      evidence: [{ sourceId: "entry:one:row:0", quote: "Led delivery" }], reason: "Direct evidence" }], gapQuestions: [] };
    const writing = projectCvWritingLibrary({ ...library, theme: { ...DEFAULT_CV_THEME, maxPages: 3 } },
      brief([{ entryId: "one", treatment: "omit" }]));
    expect(writing.entries.map(entry => entry.id)).toEqual(["two"]);
    expect(writing.profile).toBe("");
    expect(writing.theme?.maxPages).toBe(2);
    expect(writing.theme?.bodySizePt).toBe(12);
    expect(library.entries[0]?.details).toContain("Led delivery");
    expect(cvEssentialOmissionIds(fullPlan, rubric, writing)).toEqual(["r1"]);
    const projected = projectCvWritingPlan(fullPlan, rubric, writing);
    expect(projected.requirements[0]).toMatchObject({ requirementId: "r1", status: "missing", evidence: [] });
    const summarised = projectCvWritingLibrary(library, brief([{ entryId: "one", treatment: "summarise" }]));
    const budget = createCvWritingBudget(summarised, "Own delivery", 1,
      { plan: fullPlan, rubric, treatments: new Map([["one", "summarise"]]) });
    expect(budget.blocks.find(block => block.entryId === "one")?.maxBullets).toBe(1);
    expect(projectCvTargetedContent({ ...content, summarySources: ["source:profile"] },
      brief([{ entryId: "one", treatment: "omit" }])).summaryNeedsReview).toBe(true);
  });
  it("refuses Summarise for a skill category without changing other source kinds", () => {
    const library = { name: "Test", contact: "", profile: "", entries: [
      { id: "skill", kind: "skill" as const, heading: "Tools", details: "SQL", skillItems: ["SQL"] },
      { id: "qualification", kind: "training" as const, heading: "PRINCE2", details: "Completed course" },
      { id: "interest", kind: "interest" as const, heading: "Volunteering", details: "Mentored learners" },
      { id: "role", kind: "experience" as const, heading: "Analyst", details: "Used SQL",
        confirmedResponsibilities: ["Used SQL"] },
    ] } as CvLibrary;
    expect(() => validateCvTargetingEntries(library, [{ entryId: "skill", treatment: "summarise" }])).toThrow("Only experience and interests");
    expect(() => validateCvTargetingEntries(library, [{ entryId: "qualification", treatment: "summarise" }])).toThrow("Only experience and interests");
    expect(() => validateCvTargetingEntries(library, [{ entryId: "role", treatment: "summarise" }])).not.toThrow();
    expect(() => validateCvTargetingEntries(library, [{ entryId: "interest", treatment: "summarise" }])).not.toThrow();
  });
  it("removes omitted evidence from skill suggestions without renumbering source rows", () => {
    const library = { name: "Test", contact: "", profile: "", entries: [
      { id: "one", kind: "experience" as const, heading: "First", details: "Led delivery", confirmedResponsibilities: ["Led delivery"] },
      { id: "two", kind: "experience" as const, heading: "Second", details: "Managed testing", confirmedResponsibilities: ["Managed testing"] },
    ] } as CvLibrary;
    const first = brief([{ entryId: "one", treatment: "omit" }]);
    const second = brief([{ entryId: "two", treatment: "omit" }]);
    expect(cvSkillEvidenceRows(cvEligibleSkillLibrary(library, first))).toEqual([{ id: "entry:two:row:0", text: "Managed testing" }]);
    const context = cvSkillDraftContext(content);
    const hash = (target: typeof first) => cvSkillSuggestionInputHash(1, "draft", "Manage testing", [], [], context, 1, cvSkillSourcePolicy(target));
    expect(hash(first)).not.toBe(hash(second));
  });
  it("requires an eligible fresh audit of an edited summary after omitting evidence", () => {
    const target = brief([{ entryId: "one", treatment: "omit" }]);
    const assessment = { review: { claims: [{ claimId: "profile", status: "supported", evidence: [
      { id: "entry:two:row:0", quote: "Managed testing" }], reason: "" }] } } as Parameters<typeof cvTargetedSummaryFinalisationIssue>[2];
    expect(cvTargetedSummaryFinalisationIssue(content, target, assessment)).toMatch(/Edit the summary/);
    expect(cvTargetedSummaryFinalisationIssue({ ...content, summarySources: [] }, target, assessment)).toBeNull();
    expect(cvTargetedSummaryFinalisationIssue({ ...content, summarySources: [] }, target,
      { review: { claims: [{ claimId: "profile", status: "supported", evidence: [{ id: "entry:one:row:0", quote: "Led delivery" }] }] } } as typeof assessment)).toMatch(/Check the edited summary/);
  });
});
