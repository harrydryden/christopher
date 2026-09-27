/**
 * What the gap quiz needs of the Library, shaped on the server.
 *
 * The quiz offers each answer a place to be saved: a job in employment history, or an evidence
 * block. That is a list of ids and names. The page used to hand the quiz the whole Library
 * snapshot (every block's details, every row, the theme) and let the browser pick those out, so
 * the snapshot crossed the wire twice, in the RSC payload and in the HTML, for a select box.
 */
import { isActiveStoredEvidence } from "@ava/core/cv-helpers";
import type { CvGapQuiz, CvLibrary } from "@ava/core";

/** The destinations a gap answer can be saved under, and nothing else of the Library. */
export interface GapQuizLibrary {
  /** Evidence blocks an answer can be saved under, in Library order. */
  entries: Array<{ id: string; heading: string }>;
  /** Jobs in employment history, in Library order. */
  employment: Array<{ id: string; company: string; jobTitle: string }>;
}

type GapDestination = CvGapQuiz["questions"][number]["suggestedDestination"];

export function gapQuizLibrary(library: CvLibrary): GapQuizLibrary {
  return {
    // Structured experience is consolidated for generation and can carry a synthetic/grouped ID;
    // employment is its stable editable destination. Legacy unlinked experience keeps its real ID.
    entries: library.entries
      .filter((entry) => isActiveStoredEvidence(entry) && (entry.kind !== "experience" || !entry.employmentId))
      .map((entry) => ({ id: entry.id, heading: entry.heading })),
    employment: (library.employment ?? []).map((job) => ({ id: job.id, company: job.company, jobTitle: job.jobTitle })),
  };
}

/** The select's value for a suggested destination: experience under a job is saved to the job. */
export function gapDestinationValue(destination: GapDestination, library: CvLibrary): string {
  if (destination.kind === "employment") return `employment:${destination.employmentId}`;
  const entry = library.entries.find((item) => item.id === destination.entryId);
  return entry?.kind === "experience" && entry.employmentId ? `employment:${entry.employmentId}` : `evidence:${destination.entryId}`;
}

/** The quiz as the form shows it: each question with the select value it starts on. */
export type GapQuizForm = Omit<CvGapQuiz, "questions"> & {
  questions: Array<CvGapQuiz["questions"][number] & { destinationValue: string }>;
};

export function gapQuizForm(quiz: CvGapQuiz, library: CvLibrary): GapQuizForm {
  return { ...quiz, questions: quiz.questions.map((question) => ({ ...question, destinationValue: gapDestinationValue(question.suggestedDestination, library) })) };
}
