import { describe, expect, it } from "vitest";
import type { CvLibrary } from "./cv";
import type { CvRubric } from "./cv-assessment";
import { addGapAnswersToLibrary, buildCvGapQuiz } from "./cv-gap-quiz";

const library: CvLibrary = {
  name: "Ada Example", contact: "London", profile: "Operator",
  structuredExperience: true,
  employment: [{ id: "job-1", company: "Acme", jobTitle: "Lead", startDate: "2020", endDate: "", current: true }],
  entries: [
    { id: "experience-1", kind: "experience", status: "active", heading: "Lead · Acme", employmentId: "job-1", details: "Led delivery.", confirmedResponsibilities: ["Led delivery."] },
    { id: "skills", kind: "skill", status: "active", heading: "Skills", details: "Planning" },
  ],
};
const rubric: CvRubric = { caveats: [], requirements: [{ id: "r1", label: "Market launches", quote: "Launch markets", importance: "essential", category: "delivery" }] };

describe("CV gap quiz", () => {
  it("keeps only questions tied to the rubric and an existing destination", () => {
    const quiz = buildCvGapQuiz([
      { id: "q1", requirementId: "r1", requirement: "Market launches", prompt: "What did you launch?", suggestedDestination: { kind: "employment", employmentId: "job-1" } },
      { id: "q2", requirementId: "missing", requirement: "Invented", prompt: "Invent something", suggestedDestination: { kind: "evidence", entryId: "skills" } },
    ], library, 7, rubric);
    expect(quiz?.questions.map(question => question.id)).toEqual(["q1"]);
    expect(quiz?.libraryVersion).toBe(7);
  });

  it("appends confirmed answers without changing history or unrelated evidence", () => {
    const quiz = buildCvGapQuiz([
      { id: "q1", requirementId: "r1", requirement: "Market launches", prompt: "What did you launch?", suggestedDestination: { kind: "employment", employmentId: "job-1" } },
    ], library, 7, rubric)!;
    const next = addGapAnswersToLibrary(library, quiz, [{ questionId: "q1", answer: "Launched a new route to market.", destination: { kind: "employment", employmentId: "job-1" } }], id => `gap-${id}`);
    expect(next.employment).toEqual(library.employment);
    expect(next.entries[1]).toEqual(library.entries[1]);
    expect(next.entries[0]?.details).toBe("Led delivery.\nLaunched a new route to market.");
    expect(next.entries[0]?.confirmedResponsibilities).toContain("Launched a new route to market.");
    expect(library.entries[0]?.details).toBe("Led delivery.");
  });

  it("rejects answers that are not part of the persisted quiz", () => {
    const quiz = buildCvGapQuiz([
      { id: "q1", requirementId: "r1", requirement: "Market launches", prompt: "What did you launch?", suggestedDestination: { kind: "evidence", entryId: "skills" } },
    ], library, 7, rubric)!;
    expect(() => addGapAnswersToLibrary(library, quiz, [{ questionId: "q2", answer: "No.", destination: { kind: "evidence", entryId: "skills" } }], id => id)).toThrow("current quiz");
  });

  it("confirms each row of a multiline employment answer", () => {
    const quiz = buildCvGapQuiz([
      { id: "q1", requirementId: "r1", requirement: "Market launches", prompt: "What did you launch?", suggestedDestination: { kind: "employment", employmentId: "job-1" } },
    ], library, 7, rubric)!;
    const next = addGapAnswersToLibrary(library, quiz, [{ questionId: "q1", answer: "Opened the market.\nReached first revenue.", destination: { kind: "employment", employmentId: "job-1" } }], id => id);
    expect(next.entries[0]?.confirmedResponsibilities).toEqual(["Led delivery.", "Opened the market.", "Reached first revenue."]);
  });

  it("creates active evidence instead of reviving an inactive employment entry", () => {
    const inactive = { ...library, entries: library.entries.map(entry => entry.id === "experience-1" ? { ...entry, status: "inactive" as const } : entry) };
    const quiz = buildCvGapQuiz([
      { id: "q1", requirementId: "r1", requirement: "Market launches", prompt: "What did you launch?", suggestedDestination: { kind: "employment", employmentId: "job-1" } },
    ], inactive, 7, rubric)!;
    const next = addGapAnswersToLibrary(inactive, quiz, [{ questionId: "q1", answer: "Opened a new market.", destination: { kind: "employment", employmentId: "job-1" } }], id => `gap-${id}`);
    expect(next.entries.find(entry => entry.id === "experience-1")).toEqual(inactive.entries[0]);
    expect(next.entries.find(entry => entry.id === "gap-q1")).toMatchObject({
      kind: "experience", status: "active", employmentId: "job-1",
      details: "Opened a new market.", confirmedResponsibilities: ["Opened a new market."],
    });
  });

  it("refuses to save new evidence into an inactive entry", () => {
    const inactive = { ...library, entries: library.entries.map(entry => entry.id === "skills" ? { ...entry, status: "inactive" as const } : entry) };
    const quiz = buildCvGapQuiz([
      { id: "q1", requirementId: "r1", requirement: "Market launches", prompt: "What did you launch?", suggestedDestination: { kind: "evidence", entryId: "skills" } },
    ], library, 7, rubric)!;
    expect(() => addGapAnswersToLibrary(inactive, quiz, [{ questionId: "q1", answer: "Planning", destination: { kind: "evidence", entryId: "skills" } }], id => id)).toThrow("active Library entry");
  });
});
