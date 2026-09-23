import { abandonCvDraft, noteCvBuildFailure, releaseAiHolds } from "@ava/db";
import { cvBuildFailure, type CvBuildFailure } from "@ava/core";
import type { AbandonHookMap, InterruptedHookMap } from "../queue";
import { failOpenCvBuildStepsQuietly } from "./cv-journal";
import { log } from "../log";
import { sql } from "drizzle-orm";

/**
 * What a CV draft is told when the worker gave up on building it. It names the number of attempts
 * and what to do next, because the person is looking at a page that has said "generating" ever
 * since, and nothing else will tell them.
 */
export const CV_ABANDONED_MESSAGE =
  "The worker was interrupted while building this CV (3 attempts). Rebuild from Library to try again.";

/**
 * The same event in the taxonomy the page reads, so an interrupted build is not the one failure
 * with no kind and no next step.
 *
 * `worker_interrupted` is ordinarily the system's to resolve by trying again, and that is exactly
 * what it did — these hooks run only once the queue has given up on the task for good. Nothing is
 * coming, so the record says so and hands the next move to the person, which is what its message
 * has always asked for.
 */
export function cvInterruptedFailure(attempts?: { attempt: number; maxAttempts: number }, cause?: string): CvBuildFailure {
  return cvBuildFailure("worker_interrupted", CV_ABANDONED_MESSAGE, {
    resolvedBy: "user", retryable: false, action: "retry",
    ...(attempts ?? {}), ...(cause ? { cause: cause.slice(0, 500) } : {}),
  });
}

/** What the page says while the queue is bringing an interrupted build back. */
export function cvInterruptedMessage(attempts: { attempt: number; maxAttempts: number }): string {
  return `The worker was interrupted while building this CV (attempt ${attempts.attempt} of ${attempts.maxAttempts}).`;
}

/** The account a CV task is for, read from its payload. */
function draftIdOf(task: { payload: unknown }): string | null {
  const draftId = (task.payload as { draftId?: unknown } | null)?.draftId;
  return typeof draftId === "string" ? draftId : null;
}

/**
 * A quiz continuation can be queued while the worker that produced the quiz is still returning.
 * If that old lease is then declared interrupted, its hook belongs to the pre-quiz run and must
 * not overwrite or release the continuation that the person has just requested.
 */
async function isCompletedQuizPredecessor(
  task: { dedupeKey: string | null; createdAt: Date },
  deps: { db: Parameters<typeof abandonCvDraft>[0] },
  draftId: string,
): Promise<boolean> {
  if (task.dedupeKey !== `generate_cv:${draftId}`) return false;
  const completed = await deps.db.execute<{ status: string | null; completedAt: string | null }>(sql`
    select gap_quiz->>'status' as status, gap_quiz->>'completedAt' as "completedAt"
    from cv_drafts where id = ${draftId} limit 1`);
  const quiz = completed.rows[0];
  if (!quiz || !quiz.completedAt || (quiz.status !== "skipped" && quiz.status !== "answered")) return false;
  const completedAt = new Date(quiz.completedAt).getTime();
  return Number.isFinite(completedAt) && task.createdAt.getTime() <= completedAt;
}

/**
 * Closing off the work behind a task the queue has given up on.
 *
 * A task that fails normally has already written its own failure; these are for the tasks that
 * never got the chance — the process died mid-handler, or the last attempt threw. Each hook is
 * responsible for one type and must be safe to run twice: the same task can be abandoned by the
 * worker that ran it and, later, by a sweep that finds the row.
 */
export const onAbandon: AbandonHookMap = {
  generate_cv: async (task, deps, reason) => {
    const draftId = draftIdOf(task);
    if (!draftId) return;
    if (await isCompletedQuizPredecessor(task, deps, draftId)) return;
    const failure = cvInterruptedFailure({ attempt: task.attempts, maxAttempts: task.maxAttempts }, reason);
    const abandoned = await abandonCvDraft(deps.db, draftId, CV_ABANDONED_MESSAGE, failure);
    if (!abandoned) return;
    // Whatever the build was in the middle of is over; its steps would otherwise stay `running`
    // for ever and the narrative would end mid-sentence. Every attempt's, because the draft is
    // failed for good and nothing is coming back to close them.
    await failOpenCvBuildStepsQuietly(deps.db, draftId, CV_ABANDONED_MESSAGE, failure);
    log.warn("cv draft failed by the worker that gave up on its task", { draftId, taskId: task.id, userId: abandoned.userId });
    // The build held capacity against this account's monthly budget for the whole hour it was
    // allowed. Nothing is spending it now, and leaving it held refuses the rebuild we have just
    // asked the user to start. Only this build's hold: the account may have another build running.
    const released = await releaseAiHolds(deps.db, { userId: abandoned.userId, callSite: "CV", refId: draftId });
    if (released.count) log.warn("released the abandoned build's AI holds", { draftId, userId: abandoned.userId, ...released });
  },
};

/**
 * What a CV draft is told when this run of its build was cut off but the task is coming back.
 *
 * The handler writes its own failure whenever it can, but a run killed by its deadline cannot: the
 * queue has already failed the task, so the build's every write is refused by the fence, and the
 * page went on saying "progressing" — for as long as the person left it open — about a build that
 * had been abandoned three quarters of an hour earlier. The queue records it here instead, where
 * the attempt figures and the next run time are known.
 */
export const onInterrupted: InterruptedHookMap = {
  generate_cv: async (task, deps, { retryAt }) => {
    const draftId = draftIdOf(task);
    if (!draftId) return;
    if (await isCompletedQuizPredecessor(task, deps, draftId)) return;
    const attempts = { attempt: task.attempts, maxAttempts: task.maxAttempts };
    const message = cvInterruptedMessage(attempts);
    // The system is resolving this one: the draft stays `generating`, keeps its checkpoint, and
    // the page says which attempt stopped and when the next one runs.
    const failure = cvBuildFailure("worker_interrupted", message, {
      ...attempts, ...(retryAt ? { retryAt } : {}),
    });
    if (!(await noteCvBuildFailure(deps.db, draftId, failure))) return;
    // Only this attempt's steps: the next attempt has not started, and a later one must not have
    // its live motions closed by this.
    await failOpenCvBuildStepsQuietly(deps.db, draftId, message, failure, { attempt: task.attempts });
    log.warn("cv build interrupted; the queue will run it again", { draftId, taskId: task.id, ...attempts, retryAt });
  },
};
