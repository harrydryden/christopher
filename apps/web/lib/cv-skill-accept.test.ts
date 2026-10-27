import { expect, it } from "vitest";
import { CvContentSchema, CvLibrarySchema, type CvSkillSuggestion } from "@col/core";
import { countDistinctCvSkills } from "@col/core/cv-format";
import { cvReviewSuggestedSections } from "./cv-review-edits";
import { acceptCvSkillSuggestions } from "./cv-skill-accept";

const library = CvLibrarySchema.parse({ name: "Ada", contact: "", profile: "Analyst", entries: [
  { id: "role", kind: "experience", heading: "Analyst", details: "Used Excel", confirmedResponsibilities: ["Used Excel"] },
  { id: "structured", kind: "skill", heading: "Data tools", details: "My explanation of the tools.", skillItems: ["SQL"] },
  { id: "legacy", kind: "skill", heading: "Leadership", details: "Coaching, mentoring and review." },
] });
const content = CvContentSchema.parse({ name: "Ada", contact: "", summary: "Analyst", gaps: [], sections: [
  { entryId: "role", kind: "experience", heading: "Analyst", bullets: ["Used Excel"] },
  { entryId: "structured", kind: "skill", heading: "Data tools", bullets: ["SQL"], skillItems: ["SQL"] },
  { entryId: "legacy", kind: "skill", heading: "Leadership", bullets: ["Coaching, mentoring and review."] },
] });
const suggestion = (id: string, category: string, label: string): CvSkillSuggestion => ({ id, category, label,
  sourceId: "entry:role:row:0", evidenceQuote: "Used Excel", roleQuote: "spreadsheets" });

it("persists only selected labels, preserves existing Details and aligns the preview with saved sections", () => {
  const selected = [suggestion("11111111-1111-4111-8111-111111111111", "Data tools", "Excel")];
  const accepted = acceptCvSkillSuggestions(library, content, selected);
  expect(accepted.library.entries.find(entry => entry.id === "structured")).toMatchObject({
    details: "My explanation of the tools.", skillItems: ["SQL", "Excel"],
  });
  expect(accepted.content.sections.find(section => section.entryId === "structured")?.skillItems).toEqual(["SQL", "Excel"]);
  const preview = cvReviewSuggestedSections(content.sections, selected, [{ id: "structured", heading: "Data tools", items: ["SQL"] }]);
  expect(preview.map(section => [section.heading, section.skillItems ?? section.bullets]))
    .toEqual(accepted.content.sections.map(section => [section.heading, section.skillItems ?? section.bullets]));
  expect(acceptCvSkillSuggestions(library, content, []).library).toEqual(library);
});

it("reuses a saved label across categories and never duplicates an existing CV label", () => {
  const withSaved = CvLibrarySchema.parse({ ...library, entries: [...library.entries,
    { id: "methods", kind: "skill", heading: "Methods", details: "Project approach", skillItems: ["Lean Six Sigma"] }] });
  const selected = [suggestion("33333333-3333-4333-8333-333333333333", "Operations", "Lean Six Sigma"),
    suggestion("44444444-4444-4444-8444-444444444444", "Other tools", "SQL")];
  const accepted = acceptCvSkillSuggestions(withSaved, content, selected);
  expect(accepted.library.entries.filter(entry => entry.kind === "skill" && entry.skillItems?.includes("Lean Six Sigma"))).toHaveLength(1);
  expect(accepted.content.sections.find(section => section.entryId === "methods")?.skillItems).toEqual(["Lean Six Sigma"]);
  expect(accepted.content.sections.flatMap(section => section.kind === "skill" ? section.skillItems ?? [] : []).filter(label => label === "SQL")).toHaveLength(1);
  const preview = cvReviewSuggestedSections(content.sections, selected, [
    { id: "structured", heading: "Data tools", items: ["SQL"] },
    { id: "methods", heading: "Methods", items: ["Lean Six Sigma"] },
  ]);
  expect(preview.map(section => [section.heading, section.skillItems ?? section.bullets]))
    .toEqual(accepted.content.sections.map(section => [section.heading, section.skillItems ?? section.bullets]));
});

it("does not replace a prose-only legacy skill block", () => {
  const selected = [suggestion("22222222-2222-4222-8222-222222222222", "Leadership", "Team leadership")];
  const accepted = acceptCvSkillSuggestions(library, content, selected);
  expect(accepted.library.entries.find(entry => entry.id === "legacy")?.details).toBe("Coaching, mentoring and review.");
  expect(accepted.library.entries.find(entry => entry.id === "legacy")?.skillItems).toBeUndefined();
  expect(accepted.content.sections.filter(section => section.heading === "Leadership")).toHaveLength(2);
  const preview = cvReviewSuggestedSections(content.sections, selected, []);
  expect(preview.map(section => [section.heading, section.skillItems ?? section.bullets]))
    .toEqual(accepted.content.sections.map(section => [section.heading, section.skillItems ?? section.bullets]));
});

it("keeps an existing ten highlighted skills until the reviewer deliberately replaces one", () => {
  const ten = CvContentSchema.parse({ ...content, sections: [content.sections[0],
    { entryId: "structured", kind: "skill", heading: "Data tools", bullets: ["SQL"], skillItems: ["SQL", "Excel", "Power BI", "Tableau"] },
    { entryId: "people", kind: "skill", heading: "People", bullets: ["Coaching"], skillItems: ["Coaching", "Mentoring", "Hiring"] },
    { entryId: "ops", kind: "skill", heading: "Operations", bullets: ["Planning"], skillItems: ["Planning", "Delivery", "Forecasting"] },
  ] });
  const proposals = [suggestion("55555555-5555-4555-8555-555555555555", "Other", "ＳＱＬ"),
    suggestion("66666666-6666-4666-8666-666666666666", "Methods", "Lean Six Sigma")];
  const targets = [{ id: "structured", heading: "Data tools", items: ["SQL"] }];
  const labels = (sections: typeof ten.sections) => sections.filter(section => section.kind === "skill")
    .flatMap(section => section.skillItems ?? []);
  expect(countDistinctCvSkills(labels(ten.sections))).toBe(10);
  const beforeRemoval = cvReviewSuggestedSections(ten.sections, proposals, targets);
  expect(countDistinctCvSkills(labels(beforeRemoval))).toBe(11);
  expect(labels(beforeRemoval).filter(label => label === "ＳＱＬ")).toHaveLength(0);
  const replaced = structuredClone(ten.sections);
  const dataSection = replaced.find(section => section.entryId === "structured")!;
  dataSection.skillItems = dataSection.skillItems!.filter(label => label !== "Tableau");
  const final = cvReviewSuggestedSections(replaced, proposals, targets);
  expect(countDistinctCvSkills(labels(final))).toBe(10);
  expect(labels(final)).toContain("Lean Six Sigma");
  expect(labels(final)).not.toContain("Tableau");
});

it("groups Unicode-equivalent new category headings into one preview and saved section", () => {
  const selected = [suggestion("77777777-7777-4777-8777-777777777777", "Analytics", "Excel"),
    suggestion("88888888-8888-4888-8888-888888888888", "Ａｎａｌｙｔｉｃｓ", "Power BI")];
  const accepted = acceptCvSkillSuggestions(library, content, selected);
  const preview = cvReviewSuggestedSections(content.sections, selected, []);
  expect(preview.filter(section => section.heading === "Analytics").map(section => section.skillItems)).toEqual([["Excel", "Power BI"]]);
  expect(accepted.content.sections.filter(section => section.heading === "Analytics").map(section => section.skillItems))
    .toEqual([["Excel", "Power BI"]]);
  expect(accepted.library.entries.filter(entry => entry.kind === "skill" && entry.heading === "Analytics")).toHaveLength(1);
});
