import { expect, it } from "vitest";
import { cvSkillEvidenceRows, groundedCvSkillSuggestions, type CvLibrary } from "./index";

const library = {
  name: "Candidate", contact: "London", profile: "Operations",
  entries: [{ id: "role-1", kind: "experience", status: "active", heading: "Director", details: "Used SQL for reporting\nLed a team",
    confirmedResponsibilities: ["Used SQL for reporting"] }],
} satisfies CvLibrary;

it("keeps independently verified labels with exact confirmed-source and role citations", () => {
  const rows = cvSkillEvidenceRows(library);
  expect(rows).toEqual([{ id: "entry:role-1:row:0", text: "Used SQL for reporting" }]);
  const suggestions = groundedCvSkillSuggestions({ suggestions: [
    { category: "Data", label: "SQL", sourceId: rows[0]!.id, evidenceQuote: "Used SQL for reporting", roleQuote: "SQL reporting" },
    { category: "Data", label: "SQL", sourceId: rows[0]!.id, evidenceQuote: "Used SQL for reporting", roleQuote: "SQL reporting" },
    { category: "Leadership", label: "Team leadership", sourceId: rows[0]!.id, evidenceQuote: "Used SQL for reporting", roleQuote: "Team leadership" },
    { category: "Data", label: "Python", sourceId: rows[0]!.id, evidenceQuote: "Used SQL for reporting", roleQuote: "Python" },
    { category: "Data", label: "An unnecessarily long and unsupported skill label", sourceId: rows[0]!.id, evidenceQuote: "Used SQL", roleQuote: "Python" },
  ] }, rows, "Seeking SQL reporting and Python skills, with team leadership.", { decisions: [
    { index: 0, sourceSupports: true, roleRelevant: true },
    { index: 1, sourceSupports: true, roleRelevant: true },
    { index: 2, sourceSupports: false, roleRelevant: true },
    { index: 3, sourceSupports: false, roleRelevant: true },
    { index: 4, sourceSupports: true, roleRelevant: true },
  ] });
  expect(suggestions).toHaveLength(1);
  expect(suggestions[0]).toMatchObject({ category: "Data", label: "SQL" });
});

it("permits grounded paraphrases while rejecting a role-only skill and invented citations", () => {
  const rows = [{ id: "confirmed", text: "Led a team of six and used Excel" }];
  const raw = { suggestions: [
    { category: "People and operations", label: "Team leadership", sourceId: "confirmed", evidenceQuote: "Led a team of six", roleQuote: "manage analysts" },
    { category: "Data tools", label: "Excel", sourceId: "confirmed", evidenceQuote: "used Excel", roleQuote: "spreadsheets" },
    { category: "Data tools", label: "Python", sourceId: "confirmed", evidenceQuote: "used Excel", roleQuote: "Python" },
    { category: "Data tools", label: "SQL", sourceId: "confirmed", evidenceQuote: "invented SQL", roleQuote: "SQL" },
  ] };
  const result = groundedCvSkillSuggestions(raw, rows, "The role asks candidates to manage analysts, build spreadsheets and use Python and SQL.", { decisions: [
    { index: 0, sourceSupports: true, roleRelevant: true },
    { index: 1, sourceSupports: true, roleRelevant: true },
    { index: 2, sourceSupports: false, roleRelevant: true },
    { index: 3, sourceSupports: true, roleRelevant: true },
  ] });
  expect(result.map(item => item.label)).toEqual(["Team leadership", "Excel"]);
});

it("keeps three-word and punctuated labels, and handles empty or unconfirmed Experience", () => {
  expect(cvSkillEvidenceRows({ ...library, entries: [] })).toEqual([]);
  expect(cvSkillEvidenceRows({ ...library, entries: [{ ...library.entries[0]!, confirmedResponsibilities: [] }] })).toEqual([]);
  expect(cvSkillEvidenceRows({ ...library, entries: [{ ...library.entries[0]!, status: "inactive" }] })).toEqual([]);
  const rows = [{ id: "confirmed", text: "Used Lean Six Sigma, M&A and CI/CD" }];
  const raw = { suggestions: ["Lean Six Sigma", "M&A", "CI/CD"].map(label => ({ category: "Methods and tools", label,
    sourceId: "confirmed", evidenceQuote: `Used Lean Six Sigma, M&A and CI/CD`, roleQuote: "Lean Six Sigma, M&A and CI/CD" })) };
  const checked = { decisions: [0, 1, 2].map(index => ({ index, sourceSupports: true, roleRelevant: true })) };
  expect(groundedCvSkillSuggestions(raw, rows, "Lean Six Sigma, M&A and CI/CD", checked).map(item => item.label))
    .toEqual(["Lean Six Sigma", "M&A", "CI/CD"]);
});

it("balances ten grounded recommendations across categories without padding rejected candidates", () => {
  const rows = [{ id: "confirmed", text: "Used relevant tools and methods" }];
  const labels = [
    ...Array.from({ length: 4 }, (_, index) => ({ category: "Data", label: `Tool ${index + 1}` })),
    ...Array.from({ length: 4 }, (_, index) => ({ category: "People", label: `People ${index + 1}` })),
    ...Array.from({ length: 4 }, (_, index) => ({ category: "Operations", label: `Method ${index + 1}` })),
  ];
  const raw = { suggestions: labels.map(item => ({ ...item, sourceId: "confirmed", evidenceQuote: "relevant tools and methods", roleQuote: "relevant tools and methods" })) };
  const decisions = { decisions: labels.map((_, index) => ({ index, sourceSupports: true, roleRelevant: true })) };
  const result = groundedCvSkillSuggestions(raw, rows, "Seeking relevant tools and methods", decisions);
  expect(result).toHaveLength(10);
  expect(result.map(item => item.category)).toEqual(["Data", "People", "Operations", "Data", "People", "Operations", "Data", "People", "Operations", "Data"]);
  expect(result.filter(item => item.category === "Data").map(item => item.label)).toEqual(["Tool 1", "Tool 2", "Tool 3", "Tool 4"]);
  decisions.decisions = decisions.decisions.map(decision => ![0, 4, 8].includes(decision.index) ? { ...decision, sourceSupports: false } : decision);
  expect(groundedCvSkillSuggestions(raw, rows, "Seeking relevant tools and methods", decisions).map(item => item.label))
    .toEqual(["Tool 1", "People 1", "Method 1"]);
});
