import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { CvGapQuiz as CvGapQuizValue, CvLibrary } from "@col/core";
import { CvGapQuiz } from "@/components/CvGapQuiz";
import { gapDestinationValue, gapQuizForm, gapQuizLibrary } from "@/lib/cv-gap-quiz-library";

it("maps a structured experience suggestion to its editable employment record", () => {
  const library: CvLibrary = {
    name: "Example", contact: "", profile: "Leader", structuredExperience: true,
    employment: [{ id: "job:1", company: "Acme", jobTitle: "Director", startDate: "2022", endDate: "", current: true }],
    entries: [{ id: "grouped-experience", kind: "experience", heading: "Director · Acme", details: "Led delivery", employmentId: "job:1", confirmedResponsibilities: ["Led delivery"] }],
  };
  expect(gapDestinationValue({ kind: "evidence", entryId: "grouped-experience" }, library)).toBe("employment:job:1");
});

const library: CvLibrary = {
  name: "Example", contact: "ada@example.com", profile: "A long profile nobody's select box needs.", structuredExperience: true,
  employment: [{ id: "job:1", company: "Acme", industryDescriptions: "Healthcare", jobTitle: "Director", startDate: "2022", endDate: "", current: true }],
  entries: [
    { id: "grouped", kind: "experience", heading: "Director · Acme", details: "Led delivery\nRan the budget", employmentId: "job:1", confirmedResponsibilities: ["Led delivery"] },
    { id: "skills", kind: "skill", heading: "Tools", details: "SQL and Power BI" },
    { id: "gone", kind: "skill", status: "inactive", heading: "Archived", details: "Old" },
  ],
};
const quiz = {
  version: 1, status: "awaiting_answers", libraryVersion: 3,
  questions: [
    { id: "q1", requirementId: "r1", requirement: "Budget ownership", prompt: "What budget did you own?", suggestedDestination: { kind: "evidence", entryId: "grouped" } },
    { id: "q2", requirementId: "r2", requirement: "SQL", prompt: "Where did you use SQL?", suggestedDestination: { kind: "evidence", entryId: "skills" } },
  ],
} as unknown as CvGapQuizValue;

it("hands the quiz only the destinations an answer can be saved under", () => {
  // Ids and names, not the Library: no details, rows, contact or profile cross to the browser.
  expect(gapQuizLibrary(library)).toEqual({
    entries: [{ id: "skills", heading: "Tools" }],
    employment: [{ id: "job:1", company: "Acme", jobTitle: "Director" }],
  });
  expect(gapQuizForm(quiz, library).questions.map((question) => question.destinationValue)).toEqual(["employment:job:1", "evidence:skills"]);
});

it("offers the shaped destinations and starts each question on its suggestion", () => {
  const html = renderToStaticMarkup(createElement(CvGapQuiz, { quiz: gapQuizForm(quiz, library), library: gapQuizLibrary(library), action: async () => ({ ok: true as const }) }));
  const selects = html.match(/<select[\s\S]*?<\/select>/g)!;
  expect(selects).toHaveLength(2);
  for (const select of selects) {
    expect(select.match(/<option [^>]*value="([^"]+)"/g)!.map((option) => option.match(/value="([^"]+)"/)![1])).toEqual(["employment:job:1", "evidence:skills"]);
    expect(select).toContain("Director · Acme</option>");
    expect(select).toContain("Tools</option>");
  }
  expect(selects[0]).toMatch(/<option[^>]*value="employment:job:1"[^>]*selected=""/);
  expect(selects[1]).toMatch(/<option[^>]*value="evidence:skills"[^>]*selected=""/);
  expect(html).not.toContain("Ran the budget");
});
