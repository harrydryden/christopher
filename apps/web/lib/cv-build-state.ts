/**
 * Telling a slow CV build from a stopped one.
 *
 * A build is a chain of model calls that can legitimately take twenty minutes, so elapsed time
 * says nothing on its own. What separates the two is whether anything has happened lately: the
 * worker stamps `progress_at` on every stage change and every model call that returns, and the
 * task row says whether anything is still trying. During the October incident the CV page showed a
 * spinner for two and a half hours over a build whose process had died twenty seconds in.
 *
 * Pure, so the page renders one of four named states and the wording lives in one place.
 */

/** No progress for this long, while a task is still running, is worth saying out loud. */
export const CV_PROGRESS_STALE_MS = 10 * 60_000;

/**
 * The token the CV page's existing poll compares. It changes when the build changes state, when it
 * advances, and once a minute while it does not — so "last progress 12 minutes ago" keeps counting
 * on a page that is otherwise waiting for something that will never come. One mechanism, not two:
 * `/api/work-status` and the page must produce the same string for the same row.
 */
export function cvWorkVersion(
  draft: { status: string; buildStage: string | null; progressAt: Date | null; createdAt: Date },
  now: Date = new Date(),
): string {
  const since = (draft.progressAt ?? draft.createdAt).getTime();
  const minutes = Math.max(0, Math.floor((now.getTime() - since) / 60_000));
  return `${draft.status}:${draft.buildStage ?? ""}:${since}:${minutes}`;
}

export interface CvBuildTask {
  status: "queued" | "running" | "done" | "failed";
  attempts: number;
  maxAttempts: number;
  error: string | null;
  startedAt: Date | null;
}

export interface CvBuildDraft {
  status: "queued" | "generating" | "ready" | "failed";
  buildStage: string | null;
  error: string | null;
  createdAt: Date;
  progressAt: Date | null;
}

export type CvBuildPhase = "waiting" | "progressing" | "stalled" | "stopped";

export interface CvBuildState {
  phase: CvBuildPhase;
  /** Moment the build last advanced: a stage change or a model call returning. */
  lastProgressAt: Date;
  sinceProgressMs: number;
  /** One sentence naming the state, in the words the reader needs. */
  message: string;
  attempts: number | null;
  maxAttempts: number | null;
  /** Set when the phase is `stopped` and the task, not the draft, explained why. */
  taskError: string | null;
}

/**
 * `task` is the row with dedupe key `generate_cv:<draftId>`, or null when there is none — which is
 * itself a finding: a draft that says it is building with nothing queued to build it is stopped.
 */
export function cvBuildState(draft: CvBuildDraft, task: CvBuildTask | null, now: Date = new Date()): CvBuildState {
  const lastProgressAt = draft.progressAt ?? task?.startedAt ?? draft.createdAt;
  const sinceProgressMs = Math.max(0, now.getTime() - lastProgressAt.getTime());
  const attempts = task?.attempts ?? null;
  const maxAttempts = task?.maxAttempts ?? null;
  const base = { lastProgressAt, sinceProgressMs, attempts, maxAttempts, taskError: null as string | null };

  // Nothing is going to finish this. Either the task failed, or it reported itself done without
  // publishing the draft, or the row is gone altogether.
  if (!task || task.status === "failed" || task.status === "done") {
    return {
      ...base,
      phase: "stopped",
      message: draft.error ?? "This build stopped before it finished.",
      taskError: task?.error ?? null,
    };
  }

  // Queued and never claimed: the worker has not reached it yet, which is ordinary.
  if (task.status === "queued" && !task.startedAt) {
    return { ...base, phase: "waiting", message: "Waiting for the worker." };
  }

  if (sinceProgressMs >= CV_PROGRESS_STALE_MS) {
    const minutes = Math.floor(sinceProgressMs / 60_000);
    return {
      ...base,
      phase: "stalled",
      message: `No progress for ${minutes} minutes. The worker may be restarting; an administrator can see why in Operations.`,
    };
  }

  // Handed back to the queue after a failed attempt, and waiting to be picked up again.
  if (task.status === "queued") {
    return { ...base, phase: "waiting", message: "Waiting for the worker to pick this build up again." };
  }
  return { ...base, phase: "progressing", message: "This build is running." };
}
