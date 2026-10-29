import { expect, it } from "vitest";
import { CvContentSchema } from "@col/core/cv";
import { cvReviewEditedContent, cvReviewSections, cvReviewSupportingSections, librarySupportSections, cvReviewSkillLimitIssue, cvReviewSkillSectionLimitIssue, cvReviewSkillCharacterIssue, splitCvReviewSkillRow } from "./cv-review-edits";

const saved = CvContentSchema.parse({
  name: "Ada Lovelace", contact: "ada@example.com", summary: "Analyst.", gaps: [],
  sections: [
    { entryId: "role-1", kind: "experience", heading: "Analyst", bullets: ["Built systems."], bulletSources: [["entry:role-1"]] },
    { entryId: "skill-1", kind: "skill", heading: "Technical skills", bullets: ["Python"], skillItems: ["Python"], bulletSources: [["entry:skill-1"]] },
  ],
});

it("projects the exact canonical saved content and lets a removed skill have an empty heading", () => {
  const source = { ...saved, fitNotes: ["A previous fit"], summarySources: ["entry:role-1"] };
  const edited = cvReviewEditedContent(source, {
    summary: "  New profile.  ", theme: source.theme, rows: ["Built systems.", "Python"],
    removedSkillIds: ["skill-1"], addedSkills: [], skillHeadings: { "skill-1": " " }, addedSupportIds: [],
  }, []);
  expect(edited.summary).toBe("New profile.");
  expect(edited.sections).toEqual([saved.sections[0]]);
  expect(edited.summarySources).toBeUndefined();
  expect(edited.fitNotes).toBeUndefined();
  expect(source.fitNotes).toEqual(["A previous fit"]);
});

it("omits an emptied skill section while preserving unchanged section IDs and citations", () => {
  const sections = cvReviewSections(saved, ["Built systems.", "  \n "], [], []);
  expect(sections).toEqual([saved.sections[0]]);
  expect(CvContentSchema.safeParse({ ...saved, sections }).success).toBe(true);
});

it("adds manually entered skills without claiming Library sources", () => {
  const sections = cvReviewSections(saved, ["Built systems.", "Python\nSQL"], [], [
    { entryId: "manual-skill-12345678-1234-1234-1234-123456789abc", heading: "Tools", items: ["Excel", "  SQL  "] },
  ]);
  expect(sections[1]).toMatchObject({ entryId: "skill-1", skillItems: ["Python", "SQL"], bullets: ["Python", "SQL"] });
  expect(sections[1]?.bulletSources).toBeUndefined();
  expect(sections[2]).toEqual({ entryId: "manual-skill-12345678-1234-1234-1234-123456789abc", kind: "skill", heading: "Tools", skillItems: ["Excel", "SQL"], bullets: ["Excel", "SQL"] });
  expect(CvContentSchema.safeParse({ ...saved, sections }).success).toBe(true);
});

it("edits a saved skill heading without changing its identity, items or skill citations", () => {
  const sections = cvReviewSections(saved, ["Built systems.", "Python"], [], [], { "skill-1": "  Data tools  ", "role-1": "Forged role heading" });
  expect(sections[0]).toEqual(saved.sections[0]);
  expect(sections[1]).toEqual({ ...saved.sections[1], heading: "Data tools" });
  expect(CvContentSchema.safeParse({ ...saved, sections }).success).toBe(true);
  expect(cvReviewSections(saved, ["Built systems.", "Python"], [], [])).toEqual(saved.sections);
  expect(() => cvReviewSections(saved, ["Built systems.", "Python"], [], [], { "skill-1": "  " })).toThrow("heading");
  expect(() => cvReviewSections(saved, ["Built systems.", "Python"], [], [], { "skill-1": "x".repeat(251) })).toThrow("heading");
});

it("allows five CV skill sections, refuses a new sixth, and keeps older six-section CVs editable", () => {
  const skills = Array.from({ length: 6 }, (_, index) => ({ entryId: `skill-${index}`, kind: "skill" as const,
    heading: `Tools ${index}`, bullets: [`Skill ${index}`], skillItems: [`Skill ${index}`] }));
  expect(cvReviewSkillSectionLimitIssue([saved.sections[0]!, ...skills.slice(0, 5)], saved.sections)).toBeNull();
  expect(cvReviewSkillSectionLimitIssue([saved.sections[0]!, ...skills], saved.sections)).toContain("up to 5 skill sections");
  const older = [saved.sections[0]!, ...skills];
  expect(CvContentSchema.safeParse({ ...saved, sections: older }).success).toBe(true);
  expect(cvReviewSkillSectionLimitIssue(older, older)).toBeNull();
  expect(cvReviewSkillSectionLimitIssue([...older, { ...skills[0]!, entryId: "skill-6" }], older)).toContain("up to 5 skill sections");
});

it("rejects removal of Experience and leaves invalid Experience edits for validation", () => {
  expect(() => cvReviewSections(saved, ["Built systems.", "Python"], ["role-1"], [])).toThrow("Only supporting sections");
  const sections = cvReviewSections(saved, ["", "Python"], [], []);
  expect(CvContentSchema.safeParse({ ...saved, sections }).success).toBe(false);
});

it("includes or omits Training deliberately and refuses to cut off long details", () => {
  const library = { name: "Ada Lovelace", contact: "", profile: "Analyst", entries: [
    { id: "train-1", kind: "training" as const, heading: "Lean Six Sigma", details: "Completed accredited course." },
    { id: "train-long", kind: "training" as const, heading: "Long course", details: "x".repeat(1000) },
  ] };
  const available = librarySupportSections(library);
  expect(available.map(item => item.id)).toEqual(["train-1", "train-long"]);
  expect(available[1]?.issue).toMatch(/Shorten/);
  const included = cvReviewSupportingSections(saved.sections, ["train-1"], available);
  expect(included.at(-1)).toMatchObject({ entryId: "train-1", kind: "training", bullets: ["Completed accredited course."] });
  expect(cvReviewSupportingSections(saved.sections, [], available)).toEqual(saved.sections);
  expect(cvReviewSections({ ...saved, sections: included }, ["Built systems.", "Python", "Completed accredited course."], ["train-1"], []))
    .toEqual(saved.sections);
  expect(() => cvReviewSupportingSections(saved.sections, ["train-long"], available)).toThrow(/Shorten/);
});

it("refuses a supporting choice beyond twenty sections so the editor can show a recoverable issue", () => {
  const full = Array.from({ length: 20 }, (_, index) => ({ ...saved.sections[0]!, entryId: `role-${index}` }));
  expect(() => cvReviewSupportingSections(full, ["train-1"], [{ id: "train-1", kind: "training", heading: "Course", bullets: ["Completed"] }]))
    .toThrow(/section limit/);
});

it("accepts more than six skills without exceeding the bullet limit", () => {
  const items = ["Python", "SQL", "Excel", "R", "Tableau", "Power BI", "Looker"];
  const sections = cvReviewSections(saved, ["Built systems.", items.join("\n")], [], [
    { entryId: "manual-skill-12345678-1234-1234-1234-123456789abc", heading: "More tools", items },
  ]);
  expect(sections[1]?.skillItems).toHaveLength(7);
  expect(sections[1]?.bullets).toHaveLength(6);
  expect(sections[2]?.skillItems).toHaveLength(7);
  expect(sections[2]?.bullets).toHaveLength(6);
  expect(CvContentSchema.safeParse({ ...saved, sections }).success).toBe(true);
});

it("normalises an edited legacy skill section to ten individual skills and six mirrored bullets", () => {
  const legacy = CvContentSchema.parse({ ...saved, sections: [saved.sections[0], { entryId: "legacy", kind: "skill", heading: "Tools", bullets: ["Python"], bulletSources: [["entry:legacy"]] }] });
  const items = ["Python", "SQL", "Excel", "R", "Tableau", "Power BI", "Looker", "VBA", "Git", "Bash"];
  const sections = cvReviewSections(legacy, ["Built systems.", items.join("\n")], [], []);
  expect(sections[1]?.skillItems).toEqual(items);
  expect(sections[1]?.bullets).toEqual(items.slice(0, 6));
  expect(sections[1]?.bulletSources).toBeUndefined();
  expect(cvReviewSkillLimitIssue(sections)).toBeNull();
  expect(CvContentSchema.safeParse({ ...saved, sections }).success).toBe(true);
  expect(cvReviewSkillLimitIssue(cvReviewSections(legacy, ["Built systems.", [...items, "Docker"].join("\n")], [], []))).toContain("more than 10 skills");
});

it("counts legacy pills inside one bullet and preserves untouched source metadata", () => {
  const labels = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"];
  const legacy = CvContentSchema.parse({ ...saved, sections: [saved.sections[0], { entryId: "legacy-pills", kind: "skill", heading: "Tools", bullets: [labels.join(" · ")], bulletSources: [["entry:legacy-pills"]] }] });
  expect(cvReviewSkillLimitIssue(legacy.sections)).toContain("more than 10 skills");
  const untouched = cvReviewSections(legacy, ["Built systems.", labels.join("\n")], [], []);
  expect(untouched[1]).toEqual(legacy.sections[1]);
  const trimmed = cvReviewSections(legacy, ["Built systems.", labels.slice(0, 10).join("\n")], [], []);
  expect(trimmed[1]?.skillItems).toEqual(labels.slice(0, 10));
  expect(trimmed[1]?.bullets).toEqual(labels.slice(0, 6));
  expect(trimmed[1]?.bulletSources).toBeUndefined();
  expect(cvReviewSkillLimitIssue(trimmed)).toBeNull();
});

it("matches schema character validation without collapsing internal spaces", () => {
  for (const label of ["  " + "x".repeat(150) + "  ", "x".repeat(75) + "  " + "y".repeat(74)]) {
    const sections = [{ ...saved.sections[1]!, skillItems: [label] }];
    const valid = CvContentSchema.safeParse({ ...saved, sections }).success;
    expect(cvReviewSkillCharacterIssue(sections) === null).toBe(valid);
  }
});

it("splits a combined skill only when requested and retains each intended label", () => {
  const source = ["Financial Planning & Analysis, P&L Management; Unit Economics", "Technology · SQL · Python"];
  expect(splitCvReviewSkillRow(source, 0)).toEqual(["Financial Planning & Analysis", "P&L Management", "Unit Economics", source[1]]);
  expect(splitCvReviewSkillRow(source, 1)).toEqual([source[0], "Technology", "SQL", "Python"]);
  expect(splitCvReviewSkillRow(["Governance, risk and compliance"], 0)).toEqual(["Governance", "risk and compliance"]);
  expect(splitCvReviewSkillRow(["SQL"], 0)).toBeNull();
});
