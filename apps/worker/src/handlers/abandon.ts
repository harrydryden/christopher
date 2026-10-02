import { abandonCvDraft, noteCvBuildFailure, releaseAiHolds, type Db, type ReleasedHolds } from "@ava/db";
import { cvBuildFailure, type CvBuildFailure, type ScoreBatchRecord } from "@ava/core";
import type { AbandonHookMap, InterruptedHookMap } from "../queue";
import { failOpenCvBuildStepsQuietly } from "./cv-journal";
import { abandonScoreBatch } from "./score-batch-recovery";
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

/**
 * Close a CV build that is over for good. The draft's status, its open steps and its budget hold
 * are three records of that one fact, so they are closed together: the draft is failed, whatever
 * step the build was in the middle of is failed with it (every attempt's, since nothing is coming
 * back to close them, and the narrative would otherwise end mid-sentence), and the hold it kept
 * against the account's month is let go, or it refuses the rebuild the person is now asked to
 * start. Only this build's hold: the account may have another build running.
 *
 * Null when the draft was not open to abandon (finished, already failed, or deleted).
 */
export async function closeAbandonedCvDraft(db: Db, draftId: string, failure: CvBuildFailure): Promise<{ userId: string; released: ReleasedHolds } | null> {
  const abandoned = await abandonCvDraft(db, draftId, CV_ABANDONED_MESSAGE, failure);
  if (!abandoned) return null;
  await failOpenCvBuildStepsQuietly(db, draftId, CV_ABANDONED_MESSAGE, failure);
  const released = await releaseAiHolds(db, { userId: abandoned.userId, callSite: "CV", refId: draftId });
  return { userId: abandoned.userId, released };
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
  fetch_locations: async (task, deps, reason) => {
    const jobId = typeof task.payload.jobId === "string" ? task.payload.jobId : null;
    const revision = typeof task.payload.locationRevision === "string" ? task.payload.locationRevision : null;
    if (!jobId || !revision) return;
    // A killed worker may never reach the handler's catch. Mark only this unresolved revision,
    // and leave a newer fetch or a changed listing alone. The member can then retry explicitly.
    await deps.db.execute(sql`update jobs j set location_resolution = 'unavailable',
      location_error = ${`Location lookup stopped after its final attempt: ${reason}`.slice(0, 500)},
      updated_at = now()
      from career_sources s where j.id = ${jobId}::uuid and j.source_id = s.id
        and s.type = 'workday' and s.status in ('active', 'failing')
        and j.status = 'open' and j.location_revision = ${revision}
        and j.location_resolution in ('pending', 'unavailable')
        and not exists (select 1 from tasks t where t.id <> ${task.id}::uuid and t.type = 'fetch_locations'
          and t.status in ('queued', 'running') and t.payload->>'jobId' = j.id::text
          and t.payload->>'locationRevision' = j.location_revision)`);
  },
  admit_scores: async (task, deps) => {
    const userId = typeof task.payload.userId === "string" ? task.payload.userId : null;
    const jobIds = Array.isArray(task.payload.jobIds) ? task.payload.jobIds.filter((id): id is string => typeof id === "string") : [];
    if (!userId || !jobIds.length) return;
    await deps.db.transaction(async tx => {
      // A newer request writes the view and its task atomically. Take the same view lock first,
      // then use a fresh statement snapshot for the active-task check after any wait.
      await tx.execute(sql`select job_id from user_jobs where user_id = ${userId}::uuid
        and job_id in (${sql.join(jobIds.map(id => sql`${id}::uuid`), sql`, `)}) order by job_id for update`);
      await tx.execute(sql`update user_jobs uj set score_state = 'failed', score_state_at = now()
      where uj.user_id = ${userId}::uuid and uj.job_id in (${sql.join(jobIds.map(id => sql`${id}::uuid`), sql`, `)})
        and uj.score_state = 'requested'
        and not exists (select 1 from tasks t where t.id <> ${task.id}::uuid and t.type = 'admit_scores'
          and t.status in ('queued', 'running') and t.payload->>'userId' = uj.user_id::text
          and t.payload->'jobIds' ? uj.job_id::text)
        and not exists (select 1 from tasks t where t.type = 'score_job' and t.status in ('queued', 'running')
          and t.payload->>'userId' = uj.user_id::text and t.payload->>'jobId' = uj.job_id::text)
        and not exists (select 1 from tasks t, jsonb_array_elements(case
          when t.type = 'poll_score_batch' and jsonb_typeof(t.payload->'items') = 'array' then t.payload->'items'
          else '[]'::jsonb end) item
          where t.type = 'poll_score_batch' and t.status in ('queued', 'running')
            and item->>'userId' = uj.user_id::text and item->>'jobId' = uj.job_id::text)`);
    });
  },
  score_job: async (task, deps) => {
    const userId = typeof task.payload.userId === "string" ? task.payload.userId : null;
    const jobId = typeof task.payload.jobId === "string" ? task.payload.jobId : null;
    if (!userId || !jobId) return;
    await deps.db.transaction(async tx => {
      await tx.execute(sql`select job_id from user_jobs where user_id = ${userId}::uuid and job_id = ${jobId}::uuid for update`);
      await tx.execute(sql`update user_jobs uj set score_state = 'failed', score_state_at = now()
      where uj.user_id = ${userId}::uuid and uj.job_id = ${jobId}::uuid and uj.score_state = 'queued'
        and not exists (select 1 from tasks t where t.id <> ${task.id}::uuid and t.type = 'score_job'
          and t.status in ('queued', 'running') and t.payload->>'userId' = uj.user_id::text
          and t.payload->>'jobId' = uj.job_id::text)
        and not exists (select 1 from tasks t where t.type = 'admit_scores' and t.status in ('queued', 'running')
          and t.payload->>'userId' = uj.user_id::text and t.payload->'jobIds' ? uj.job_id::text)
        and not exists (select 1 from tasks t, jsonb_array_elements(case
          when t.type = 'poll_score_batch' and jsonb_typeof(t.payload->'items') = 'array' then t.payload->'items'
          else '[]'::jsonb end) item
          where t.type = 'poll_score_batch' and t.status in ('queued', 'running')
            and item->>'userId' = uj.user_id::text and item->>'jobId' = uj.job_id::text)`);
    });
  },
  generate_cv: async (task, deps, reason) => {
    const draftId = draftIdOf(task);
    if (!draftId) return;
    if (await isCompletedQuizPredecessor(task, deps, draftId)) return;
    const failure = cvInterruptedFailure({ attempt: task.attempts, maxAttempts: task.maxAttempts }, reason);
    const abandoned = await closeAbandonedCvDraft(deps.db, draftId, failure);
    if (!abandoned) return;
    log.warn("cv draft failed by the worker that gave up on its task", { draftId, taskId: task.id, userId: abandoned.userId });
    const { released } = abandoned;
    if (released.count) log.warn("released the abandoned build's AI holds", { draftId, userId: abandoned.userId, ...released });
  },
  // A scoring batch whose results could not be read: its roles are scored live, its holds let go.
  poll_score_batch: async (task, deps, reason) => {
    const record = task.payload as unknown as ScoreBatchRecord;
    const { requeued } = await abandonScoreBatch(deps.db, record);
    log.error("gave up on a scoring batch; its roles are scored live and any cost it ran up is not in the ledger", {
      batchId: record.batchId, taskId: task.id, roles: record.items?.length ?? 0, requeued, reason });
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
