import { abandonCvDraft, releaseAiHolds } from "@christopher/db";
import type { AbandonHookMap } from "../queue";
import { log } from "../log";

/**
 * What a CV draft is told when the worker gave up on building it. It names the number of attempts
 * and what to do next, because the person is looking at a page that has said "generating" ever
 * since, and nothing else will tell them.
 */
export const CV_ABANDONED_MESSAGE =
  "The worker was interrupted while building this CV (3 attempts). Rebuild from Library to try again.";

/**
 * Closing off the work behind a task the queue has given up on.
 *
 * A task that fails normally has already written its own failure; these are for the tasks that
 * never got the chance — the process died mid-handler, or the last attempt threw. Each hook is
 * responsible for one type and must be safe to run twice: the same task can be abandoned by the
 * worker that ran it and, later, by a sweep that finds the row.
 */
export const onAbandon: AbandonHookMap = {
  generate_cv: async (task, deps) => {
    const draftId = (task.payload as { draftId?: unknown }).draftId;
    if (typeof draftId !== "string") return;
    const abandoned = await abandonCvDraft(deps.db, draftId, CV_ABANDONED_MESSAGE);
    if (!abandoned) return;
    log.warn("cv draft failed by the worker that gave up on its task", { draftId, taskId: task.id, userId: abandoned.userId });
    // The build held capacity against this account's monthly budget for the whole half hour it
    // was allowed. Nothing is spending it now, and leaving it held refuses the rebuild we have
    // just asked the user to start.
    const released = await releaseAiHolds(deps.db, { userId: abandoned.userId, callSite: "CV" });
    if (released.count) log.warn("released the abandoned build's AI holds", { draftId, userId: abandoned.userId, ...released });
  },
};
