import { expect, it } from "vitest";
import { CvLibrarySchema } from "@ava/core/cv";
import { editedCvSkillEntryIds, normaliseSubmittedLibrarySkills, parseCvSkillList } from "./cv-skill-list";

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
  const normalised = normaliseSubmittedLibrarySkills(raw, ["skills"]) as typeof raw;
  expect(normalised.entries[0]?.skillItems).toHaveLength(7);
  expect(normalised.entries[0]?.skillItems?.[6]).toBe(longLabel);
  expect(normalised.entries[0]?.details).toBe(details);
  expect(normalised.entries[1]?.skillItems).toEqual(["Old A, Old B"]);
  expect(normalised.entries[2]?.details).toBe(education);
  expect(normalised.entries[3]?.details).toBe(raw.entries[3]?.details);
  expect(CvLibrarySchema.safeParse(normalised).success).toBe(true);
});

it("keeps canonical comma labels and indices when another Library field or skill label changes", () => {
  const original = CvLibrarySchema.parse({ name: "Example", contact: "", profile: "Original bio", entries: [
    { id: "skills", kind: "skill", heading: "Compliance", details: "Scope", skillItems: ["Governance, risk and compliance", "Reporting"] },
    { id: "archived", kind: "skill", status: "inactive", heading: "Old", details: "Past scope", skillItems: ["Old A; Old B"] },
  ] });
  const bioEdited = { ...original, profile: "New bio" };
  expect(editedCvSkillEntryIds(bioEdited, original)).toEqual([]);
  expect(normaliseSubmittedLibrarySkills(bioEdited, [], original)).toBe(bioEdited);
  const skillEdited = { ...original, entries: original.entries.map(item => item.id === "skills" ? { ...item, skillItems: ["Governance, risk and compliance", "Reporting", "SQL; Python"] } : item) };
  expect(editedCvSkillEntryIds(skillEdited, original)).toEqual(["skills"]);
  const normalised = normaliseSubmittedLibrarySkills(skillEdited, ["skills"], original) as CvLibrarySchemaType;
  expect(normalised.entries[0]?.skillItems).toEqual(["Governance, risk and compliance", "Reporting", "SQL", "Python"]);
  expect(normalised.entries[1]?.skillItems).toEqual(["Old A; Old B"]);
});

type CvLibrarySchemaType = ReturnType<typeof CvLibrarySchema.parse>;
