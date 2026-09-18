import { abandonCvDraft, releaseAiHolds } from "@christopher/db";
import { cvBuildFailure, type CvBuildFailure } from "@christopher/core";
import type { AbandonHookMap } from "../queue";
import { failOpenCvBuildStepsQuietly } from "./cv-journal";
import { log } from "../log";

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
    const draftId = (task.payload as { draftId?: unknown }).draftId;
    if (typeof draftId !== "string") return;
    const failure = cvInterruptedFailure({ attempt: task.attempts, maxAttempts: task.maxAttempts }, reason);
    const abandoned = await abandonCvDraft(deps.db, draftId, CV_ABANDONED_MESSAGE, failure);
    if (!abandoned) return;
    // Whatever the build was in the middle of is over; its steps would otherwise stay `running`
    // for ever and the narrative would end mid-sentence.
    await failOpenCvBuildStepsQuietly(deps.db, draftId, CV_ABANDONED_MESSAGE, failure);
    log.warn("cv draft failed by the worker that gave up on its task", { draftId, taskId: task.id, userId: abandoned.userId });
    // The build held capacity against this account's monthly budget for the whole half hour it
    // was allowed. Nothing is spending it now, and leaving it held refuses the rebuild we have
    // just asked the user to start.
    const released = await releaseAiHolds(deps.db, { userId: abandoned.userId, callSite: "CV" });
    if (released.count) log.warn("released the abandoned build's AI holds", { draftId, userId: abandoned.userId, ...released });
  },
};
