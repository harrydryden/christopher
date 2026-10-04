import { expect, it } from "vitest";
import { CvLibrarySchema } from "@ava/core/cv";
import { normaliseSubmittedLibrarySkills, parseCvSkillList } from "./cv-skill-list";

it("parses the six named skills without splitting ampersands and removes bullet markers and repeats", () => {
  const input = "• Financial Planning & Analysis, P&L Management; Unit Economics\n- Product Operations, Customer Success, Customer Support\n* financial planning & analysis";
  expect(parseCvSkillList(input)).toEqual([
    "Financial Planning & Analysis", "P&L Management", "Unit Economics", "Product Operations", "Customer Success", "Customer Support",
  ]);
});

it("normalises labels for save and preserves supporting details and other evidence verbatim", () => {
  const details = `${"Financial planning across several products, with a long account of scope and methods. ".repeat(6).trim()}\nSecond paragraph: budgets, reporting, and support handovers.`;
  expect(details.length).toBeGreaterThan(150);
  const education = "Degree details, including a dissertation and research methods.";
  const longLabel = "A".repeat(150);
  const raw = {
    name: "Example", contact: "", profile: "",
    entries: [
      { id: "skills", kind: "skill", heading: "Commercial skills", details, skillItems: [`Financial Planning & Analysis, P&L Management, Unit Economics, Product Operations, Customer Success, Customer Support\n${longLabel}`] },
      { id: "archived", kind: "skill", status: "inactive", heading: "Old skills", details: "Past evidence", skillItems: ["Old A, Old B"] },
      { id: "education", kind: "education", heading: "Degree", details: education },
      { id: "experience", kind: "experience", heading: "Role", details: "Worked with customers, improved outcomes." },
    ],
  };
  const normalised = normaliseSubmittedLibrarySkills(raw) as typeof raw;
  expect(normalised.entries[0]?.skillItems).toHaveLength(7);
  expect(normalised.entries[0]?.skillItems?.[6]).toBe(longLabel);
  expect(normalised.entries[0]?.details).toBe(details);
  expect(normalised.entries[1]?.skillItems).toEqual(["Old A, Old B"]);
  expect(normalised.entries[2]?.details).toBe(education);
  expect(normalised.entries[3]?.details).toBe(raw.entries[3]?.details);
  expect(CvLibrarySchema.safeParse(normalised).success).toBe(true);
});
