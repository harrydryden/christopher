import { expect, it } from "vitest";
import { CvContentSchema } from "@ava/core/cv";
import { cvReviewSections, cvReviewSkillLimitIssue } from "./cv-review-edits";

const saved = CvContentSchema.parse({
  name: "Ada Lovelace", contact: "ada@example.com", summary: "Analyst.", gaps: [],
  sections: [
    { entryId: "role-1", kind: "experience", heading: "Analyst", bullets: ["Built systems."], bulletSources: [["entry:role-1"]] },
    { entryId: "skill-1", kind: "skill", heading: "Technical skills", bullets: ["Python"], skillItems: ["Python"], bulletSources: [["entry:skill-1"]] },
  ],
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

it("rejects removal of non-skill sections and leaves invalid non-skill edits for validation", () => {
  expect(() => cvReviewSections(saved, ["Built systems.", "Python"], ["role-1"], [])).toThrow("Only skill sections");
  const sections = cvReviewSections(saved, ["", "Python"], [], []);
  expect(CvContentSchema.safeParse({ ...saved, sections }).success).toBe(false);
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
