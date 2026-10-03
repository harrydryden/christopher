import { expect, it } from "vitest";
import { CvContentSchema } from "@ava/core/cv";
import { cvReviewSections } from "./cv-review-edits";

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
