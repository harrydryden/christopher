/**
 * The CV page's states. A build legitimately takes twenty minutes, so the question is never "how
 * long has this been going" but "has anything happened lately, and is anything still trying" —
 * and, once it has stopped, "whose move is it": the queue's, on its own, or the person's.
 */
import { expect, it } from "vitest";
import {
  CV_WORKER_STOPPED_MESSAGE,
  cvBuildState,
  cvStepsSignature,
  cvWorkVersion,
  failureWayForward,
  normaliseCvStepsSignature,
  type CvBuildDraft,
  type CvBuildTask,
} from "./cv-build-state";
import type { CvBuildFailure } from "@ava/core";

const now = new Date("2026-09-18T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

const draft = (overrides: Partial<CvBuildDraft> = {}): CvBuildDraft => ({
  status: "generating",
  buildStage: "analysing",
  error: null,
  createdAt: ago(30 * 60_000),
  progressAt: ago(60_000),
  ...overrides,
});
const task = (overrides: Partial<CvBuildTask> = {}): CvBuildTask => ({
  status: "running",
  attempts: 1,
  maxAttempts: 3,
  error: null,
  startedAt: ago(5 * 60_000),
  ...overrides,
});

it("calls a build with recent progress progressing, and carries the attempt through", () => {
  const state = cvBuildState(draft(), task({ attempts: 2, maxAttempts: 3 }), now);
  expect(state.phase).toBe("progressing");
  expect(state.attempts).toBe(2);
  expect(state.maxAttempts).toBe(3);
  expect(state.lastProgressAt).toEqual(ago(60_000));
});

it("says so, in minutes, when a running build has not moved for ten", () => {
  const state = cvBuildState(draft({ progressAt: ago(12 * 60_000) }), task(), now);
  expect(state.phase).toBe("stalled");
  expect(state.message).toBe(
    "No progress for 12 minutes. The worker may be restarting; an administrator can see why in Operations.",
  );
  // Just inside the window is still ordinary slowness.
  expect(cvBuildState(draft({ progressAt: ago(9 * 60_000) }), task(), now).phase).toBe("progressing");
});

it("calls a build stopped when nothing is working on it, whatever the draft still says", () => {
  // The incident: the process died twenty seconds in, the draft stayed `generating`, and the page
  // showed a spinner for two and a half hours.
  const missing = cvBuildState(draft({ progressAt: ago(150 * 60_000) }), null, now);
  expect(missing.phase).toBe("stopped");
  expect(missing.message).toBe("This build stopped before it finished.");
  expect(missing.attempts).toBeNull();

  const failed = cvBuildState(draft(), task({ status: "failed", error: "generate_cv exceeded its 2700s deadline", attempts: 28 }), now);
  expect(failed.phase).toBe("stopped");
  expect(failed.taskError).toContain("deadline");
  expect(failed.attempts).toBe(28);

  // The draft's own error, when it has one, is the sentence the person should read.
  const explained = cvBuildState(draft({ error: "Your monthly AI budget is spent." }), null, now);
  expect(explained.message).toBe("Your monthly AI budget is spent.");

  // A task that reported itself done without publishing the draft is stopped too.
  expect(cvBuildState(draft(), task({ status: "done" }), now).phase).toBe("stopped");
});

it("calls an unclaimed queued build waiting, and measures from creation when nothing has run yet", () => {
  const state = cvBuildState(
    draft({ status: "queued", buildStage: null, progressAt: null, createdAt: ago(30_000) }),
    task({ status: "queued", attempts: 0, startedAt: null }),
    now,
  );
  expect(state.phase).toBe("waiting");
  expect(state.message).toBe("Waiting for the worker.");
  expect(state.lastProgressAt).toEqual(ago(30_000));

  // Handed back to the queue after an attempt: still waiting, but for a second try.
  const requeued = cvBuildState(draft({ progressAt: ago(30 * 60_000) }), task({ status: "queued", attempts: 1, startedAt: ago(40 * 60_000) }), now);
  expect(requeued.phase).toBe("stalled");
});

it("changes the poll's version on progress and once a minute while there is none", () => {
  const still = draft({ progressAt: ago(5 * 60_000) });
  expect(cvWorkVersion(still, now)).not.toBe(cvWorkVersion(still, new Date(now.getTime() + 60_000)));
  expect(cvWorkVersion(still, now)).toBe(cvWorkVersion(still, new Date(now.getTime() + 5_000)));
  expect(cvWorkVersion(still, now)).not.toBe(cvWorkVersion(draft({ progressAt: ago(1_000) }), now));
  expect(cvWorkVersion(still, now)).not.toBe(cvWorkVersion({ ...still, buildStage: "writing" }, now));
});

const failure = (overrides: Partial<CvBuildFailure> = {}): CvBuildFailure => ({
  kind: "overloaded",
  resolvedBy: "system",
  retryable: true,
  message: "The model provider was overloaded and the attempt was abandoned.",
  motion: "write",
  attempt: 1,
  maxAttempts: 3,
  retryAt: new Date(now.getTime() + 4 * 60_000).toISOString(),
  ...overrides,
});

it("says the system is retrying, when it is, and when it will", () => {
  const state = cvBuildState(
    draft({ failure: failure() }),
    task({ status: "queued", attempts: 1, startedAt: ago(3 * 60_000) }),
    now,
    "UTC",
  );
  expect(state.phase).toBe("retrying");
  expect(state.tone).toBe("amber");
  expect(state.title).toBe("The model provider is overloaded");
  expect(state.message).toBe(
    "Attempt 1 stopped: The model provider is overloaded. Retrying automatically at 12:04 (attempt 2 of 3).",
  );
  // Nothing for the person to do while the queue holds it.
  expect(state.action).toBeNull();
  expect(state.retryAt).toEqual(new Date(now.getTime() + 4 * 60_000));

  // The moment has passed and the worker has not taken it: say that, rather than a time in the past.
  const overdue = cvBuildState(
    draft({ failure: failure({ retryAt: ago(60_000).toISOString() }) }),
    task({ status: "queued", attempts: 1, startedAt: ago(3 * 60_000) }),
    now,
  );
  expect(overdue.message).toBe(
    "Attempt 1 stopped: The model provider is overloaded. Waiting for the worker to pick this build up again.",
  );

  // Clock times are the deployment's, like every other time in the interface.
  expect(cvBuildState(draft({ failure: failure() }), task({ status: "queued" }), now, "Europe/London").message).toContain("at 13:04");

  // Once the queue has claimed the next attempt, the record is history and the build is running —
  // on the attempt the queue is on, not the one the stale record stopped at.
  const resumed = cvBuildState(draft({ failure: failure() }), task({ status: "running", attempts: 2 }), now);
  expect(resumed.phase).toBe("progressing");
  expect(resumed.attempts).toBe(2);
  expect(resumed.maxAttempts).toBe(3);

  // Nothing is holding it any more: that is stopped, not retrying, whatever the record says.
  expect(cvBuildState(draft({ failure: failure() }), null, now).phase).toBe("stopped");
});

it("says a build that outlived its deadline ran out of time, and when it runs again", () => {
  // The queue writes this one from outside the handler when a build passes its 45 minutes, while
  // attempts remain: the draft is still generating and the task is back in the queue.
  const state = cvBuildState(
    draft({ progressAt: ago(46 * 60_000), failure: failure({ kind: "worker_interrupted", message: "This build ran out of time and was handed back.", motion: undefined }) }),
    task({ status: "queued", attempts: 1, startedAt: ago(46 * 60_000) }),
    now,
    "UTC",
  );
  expect(state.phase).toBe("retrying");
  expect(state.message).toBe("Attempt 1 ran out of time. Retrying automatically at 12:04 (attempt 2 of 3).");
  expect(state.title).toBe("The worker was interrupted");
  expect(state.action).toBeNull();
});

it("never reads the queue's own bounce back as the reason a build stopped", () => {
  // A lease another worker was holding hands the task back to the queue with its message on the
  // row. Repeating that under "The queue recorded:" told the person about a lock they do not have.
  const bounced = cvBuildState(
    draft({ status: "failed", error: "This build stopped before it finished." }),
    task({ status: "queued", attempts: 1, error: "LeaseBusyError: Operation already running: cv:4f6c" }),
    now,
  );
  expect(bounced.phase).toBe("failed");
  expect(bounced.taskError).toBeNull();

  // The queue giving up is a different thing, and its message is the only account of it there is.
  const givenUp = cvBuildState(
    draft({ status: "failed" }),
    task({ status: "failed", error: "Error: generate_cv exceeded its 2700s deadline" }),
    now,
  );
  expect(givenUp.taskError).toBe("Error: generate_cv exceeded its 2700s deadline");
});

it("names the failure, its heading and the person's way forward on a failed draft", () => {
  const state = cvBuildState(
    draft({
      status: "failed",
      error: "Not enough AI budget",
      failure: failure({
        kind: "budget_exhausted",
        resolvedBy: "user",
        retryable: false,
        action: "raise_budget",
        message: "This build needs $3.06 and $1.20 is left of your $50.00 budget this month.",
        motion: "admit_budget",
        retryAt: undefined,
      }),
    }),
    task({ status: "failed" }),
    now,
  );
  expect(state.phase).toBe("failed");
  expect(state.tone).toBe("red");
  expect(state.title).toBe("Not enough AI budget");
  expect(state.message).toBe("This build needs $3.06 and $1.20 is left of your $50.00 budget this month.");
  expect(state.action).toBe("raise_budget");

  // Attempts spent on something the system was resolving: the heading says so, and the way out is
  // the retry, which resumes from whatever the build already paid for.
  const exhausted = cvBuildState(
    draft({
      status: "failed",
      failure: failure({ attempt: 3, retryAt: undefined }),
      buildCheckpoint: { rubric: { requirements: [] } as unknown as NonNullable<CvBuildDraft["buildCheckpoint"]>["rubric"], contentAt: now.toISOString() },
    }),
    task({ status: "failed", attempts: 3 }),
    now,
  );
  expect(exhausted.title).toBe("Gave up after 3 attempts: The model provider is overloaded");
  expect(exhausted.action).toBe("retry");
  expect(exhausted.resumeNote).toBe(
    "A retry resumes from the requirements already extracted and the wording already written, so it does not pay for that again.",
  );

  // A draft that failed before any of this existed still reads, and still offers the retry.
  const older = cvBuildState(draft({ status: "failed", error: "Model output was not valid." }), task({ status: "failed" }), now);
  expect(older.title).toBeNull();
  expect(older.message).toBe("Model output was not valid.");
  expect(older.action).toBe("retry");
  expect(older.resumeNote).toBeNull();
});

it("offers each failure the page that fixes it, and the retry only where it would work", () => {
  expect(failureWayForward("raise_budget", { canRetry: true })).toEqual({
    links: [{ label: "Raise the AI budget", href: "/settings" }],
    note: null,
    retry: true,
    retryNote: "When you have done that, retry generation.",
  });
  expect(failureWayForward("shorten_or_raise_pages", { canRetry: true }).links).toEqual([
    { label: "Shorten the Library", href: "/library" },
    { label: "Raise the page limit", href: "/settings" },
  ]);
  expect(failureWayForward("paste_description", { jobId: "job-1" }).links).toEqual([
    { label: "Paste the full job description", href: "/applications?job=job-1" },
  ]);
  // A draft whose role has been deleted still has the applications table's paste field.
  expect(failureWayForward("paste_description", { jobId: null }).links[0]!.href).toBe("/applications");
  expect(failureWayForward("check_model_access", { admin: true }).links.map((link) => link.href)).toEqual(["/admin/settings", "/admin/health"]);
  expect(failureWayForward("check_model_access", { admin: false })).toMatchObject({
    links: [],
    note: "Ask an administrator to check this deployment's model access.",
  });
  expect(failureWayForward("choose_model").links).toEqual([{ label: "Choose a different CV model", href: "/settings" }]);
  // The retry is a form over `assessCvDraft`, which refuses a finalised or still-building draft.
  expect(failureWayForward("retry", { canRetry: false }).retry).toBe(false);
  expect(failureWayForward("retry", { canRetry: true })).toMatchObject({ retry: true, retryNote: null });
  expect(failureWayForward(null, { canRetry: true }).retry).toBe(false);
});

it("signs the ledger from the rows the page already has, in the poll's own terms", () => {
  const step = (status: "running" | "done", startedAt: Date, finishedAt: Date | null) => ({ status, startedAt, finishedAt });
  const steps = [
    step("done", ago(120_000), ago(60_000)),
    step("done", ago(90_000), ago(30_000)),
    step("running", ago(20_000), null),
  ];
  expect(cvStepsSignature(steps)).toBe(`3:1:${ago(20_000).toISOString()}`);
  // An empty ledger signs as one, and a motion closing moves the signature.
  expect(cvStepsSignature([])).toBe("0:0:");
  expect(cvStepsSignature([...steps.slice(0, 2), step("done", ago(20_000), ago(5_000))])).toBe(`3:0:${ago(5_000).toISOString()}`);

  // The poll's side comes from SQL: `timestamptz::text`, microseconds, in the database's timezone.
  // Both are reduced to the same moment, or the page would refresh itself every ten seconds.
  expect(normaliseCvStepsSignature("3:1:2026-09-18 11:59:40.123456+00")).toBe("3:1:2026-09-18T11:59:40.123Z");
  expect(normaliseCvStepsSignature("3:1:2026-09-18 12:59:40.123456+01")).toBe("3:1:2026-09-18T11:59:40.123Z");
  expect(normaliseCvStepsSignature("0:0:")).toBe("0:0:");
  expect(normaliseCvStepsSignature("0:0:nonsense")).toBe("0:0:nonsense");
});

it("carries the ledger and the failure into the poll's version", () => {
  const still = draft({ progressAt: ago(5 * 60_000) });
  expect(cvWorkVersion(still, now, "4:1:2026-09-18 11:58:00+00")).not.toBe(cvWorkVersion(still, now, "5:1:2026-09-18 11:59:00+00"));
  expect(cvWorkVersion(still, now, "4:1:x")).toBe(cvWorkVersion(still, now, "4:1:x"));
  // A recorded failure changes it, and so does the same kind failing on the next attempt.
  expect(cvWorkVersion({ ...still, failure: failure() }, now)).not.toBe(cvWorkVersion(still, now));
  expect(cvWorkVersion({ ...still, failure: failure({ attempt: 2 }) }, now)).not.toBe(cvWorkVersion({ ...still, failure: failure() }, now));
});

it("says a queued build is waiting for a worker that is not running, rather than simply waiting", () => {
  const queued = draft({ status: "queued", buildStage: null, progressAt: null });
  expect(cvBuildState(queued, task({ status: "queued", attempts: 0, startedAt: null, workerStopped: true }), now))
    .toMatchObject({ phase: "waiting", tone: "amber", message: CV_WORKER_STOPPED_MESSAGE });
  // A running build has a worker by definition, and a queued one with a live worker waits as usual.
  expect(cvBuildState(queued, task({ status: "queued", attempts: 0, startedAt: null, workerStopped: false }), now).message)
    .toBe("Waiting for the worker.");
});
