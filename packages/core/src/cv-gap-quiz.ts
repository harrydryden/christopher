import { z } from "zod";
import { isActiveStoredEvidence, type CvLibrary } from "./cv";
import { CvRubricSchema, type CvRubric } from "./cv-assessment";

export const CV_GAP_QUIZ_MAX_QUESTIONS = 4;

export const CvGapDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("employment"), employmentId: z.string().min(1).max(100) }),
  z.object({ kind: z.literal("evidence"), entryId: z.string().min(1).max(100) }),
]);

/** A short factual question tied to one role requirement and one existing Library destination. */
export const CvGapQuestionSchema = z.object({
  id: z.string().min(1).max(80),
  requirementId: z.string().min(1).max(40),
  requirement: z.string().trim().min(1).max(250),
  prompt: z.string().trim().min(1).max(500),
  suggestedDestination: CvGapDestinationSchema,
});
export type CvGapQuestion = z.infer<typeof CvGapQuestionSchema>;

export const CvGapAnswerSchema = z.object({
  questionId: z.string().min(1).max(80),
  answer: z.string().trim().min(1).max(2_000),
  destination: CvGapDestinationSchema,
});
export type CvGapAnswer = z.infer<typeof CvGapAnswerSchema>;

export const CvGapQuizSchema = z.object({
  version: z.literal(1),
  status: z.enum(["awaiting_answers", "answered", "skipped"]),
  libraryVersion: z.number().int().positive(),
  questions: z.array(CvGapQuestionSchema).min(1).max(CV_GAP_QUIZ_MAX_QUESTIONS),
  answers: z.array(CvGapAnswerSchema).max(CV_GAP_QUIZ_MAX_QUESTIONS).optional(),
  completedAt: z.string().datetime().optional(),
  continuationDraftId: z.string().uuid().optional(),
}).superRefine((quiz, ctx) => {
  if (new Set(quiz.questions.map(question => question.id)).size !== quiz.questions.length)
    ctx.addIssue({ code: "custom", path: ["questions"], message: "Question IDs must be unique." });
  const ids = new Set(quiz.questions.map(question => question.id));
  if (quiz.answers?.some(answer => !ids.has(answer.questionId)))
    ctx.addIssue({ code: "custom", path: ["answers"], message: "Answers must belong to this quiz." });
  if (quiz.answers && new Set(quiz.answers.map(answer => answer.questionId)).size !== quiz.answers.length)
    ctx.addIssue({ code: "custom", path: ["answers"], message: "Each question can be answered once." });
});
export type CvGapQuiz = z.infer<typeof CvGapQuizSchema>;

/**
 * Turn planner output into the persisted pause payload. Invalid or stale destinations are omitted;
 * an empty result means the build can continue without interrupting the person.
 */
export function buildCvGapQuiz(
  questions: readonly CvGapQuestion[],
  library: CvLibrary,
  libraryVersion: number,
  rubric: CvRubric,
): CvGapQuiz | null {
  const requirements = new Map(CvRubricSchema.parse(rubric).requirements.map(item => [item.id, item]));
  const employmentIds = new Set(library.employment?.map(item => item.id) ?? []);
  const entries = new Set(library.entries.map(item => item.id));
  const seenQuestions = new Set<string>();
  const seenRequirements = new Set<string>();
  const valid = questions.flatMap(raw => {
    const parsed = CvGapQuestionSchema.safeParse(raw);
    if (!parsed.success) return [];
    const question = parsed.data;
    const requirement = requirements.get(question.requirementId);
    const destinationExists = question.suggestedDestination.kind === "employment"
      ? employmentIds.has(question.suggestedDestination.employmentId)
      : entries.has(question.suggestedDestination.entryId);
    if (!requirement || requirement.label !== question.requirement || !destinationExists || seenQuestions.has(question.id) || seenRequirements.has(question.requirementId)) return [];
    seenQuestions.add(question.id);
    seenRequirements.add(question.requirementId);
    return [question];
  }).slice(0, CV_GAP_QUIZ_MAX_QUESTIONS);
  return valid.length ? CvGapQuizSchema.parse({ version: 1, status: "awaiting_answers", libraryVersion, questions: valid }) : null;
}

/** Append only wording the person explicitly confirmed; every pre-existing Library field survives. */
export function addGapAnswersToLibrary(
  library: CvLibrary,
  quiz: CvGapQuiz,
  answers: readonly CvGapAnswer[],
  idForQuestion: (questionId: string) => string,
): CvLibrary {
  const parsedQuiz = CvGapQuizSchema.parse(quiz);
  const parsedAnswers = z.array(CvGapAnswerSchema).min(1).max(CV_GAP_QUIZ_MAX_QUESTIONS).parse(answers);
  const byQuestion = new Map(parsedQuiz.questions.map(question => [question.id, question]));
  const entries = library.entries.map(entry => ({ ...entry }));
  const seen = new Set<string>();
  for (const answer of parsedAnswers) {
    if (seen.has(answer.questionId)) throw new Error("Each question can be answered once.");
    seen.add(answer.questionId);
    const question = byQuestion.get(answer.questionId);
    if (!question) throw new Error("This answer does not belong to the current quiz.");
    const destination = answer.destination;
    const answerRows = answer.answer.split(/\r?\n/).map(row => row.trim()).filter(Boolean);
    // The library here is the account's stored one, which has not been parsed: archived is the
    // only status that stands a block aside. A block an earlier release stored as a draft is the
    // job's evidence — the generation that asked this question read it as one — so the answer is
    // appended to it rather than landing in a second block for the same job that the editor,
    // which shows one block per job, would never show.
    let index = destination.kind === "evidence"
      ? entries.findIndex(entry => entry.id === destination.entryId)
      : entries.findIndex(entry => entry.kind === "experience" && entry.employmentId === destination.employmentId
          && isActiveStoredEvidence(entry));
    if (destination.kind === "evidence" && index < 0) throw new Error("The selected Library evidence no longer exists.");
    if (destination.kind === "evidence" && !isActiveStoredEvidence(entries[index]!))
      throw new Error("New evidence can only be added to a Library entry that has not been archived.");
    if (destination.kind === "employment" && !(library.employment ?? []).some(job => job.id === destination.employmentId))
      throw new Error("The suggested employment record no longer exists.");
    if (index < 0 && destination.kind === "employment") {
      const job = library.employment!.find(item => item.id === destination.employmentId)!;
      entries.push({
        id: idForQuestion(answer.questionId), kind: "experience", status: "active",
        heading: `${job.jobTitle} · ${job.company}`, employmentId: job.id,
        details: answerRows.join("\n"), confirmedResponsibilities: answerRows,
      });
      continue;
    }
    const entry = entries[index]!;
    const rows = entry.details.split("\n").map(row => row.trim()).filter(Boolean);
    const known = new Set(rows.map(row => row.toLocaleLowerCase()));
    for (const answerRow of answerRows) {
      if (!known.has(answerRow.toLocaleLowerCase())) rows.push(answerRow);
    }
    entries[index] = {
      ...entry,
      details: rows.join("\n"),
      ...(entry.kind === "experience" ? {
        confirmedResponsibilities: [...new Set([...(entry.confirmedResponsibilities ?? []), ...answerRows])],
      } : {}),
    };
  }
  return { ...library, entries };
}
