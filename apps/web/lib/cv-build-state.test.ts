/**
 * The CV page's four states. A build legitimately takes twenty minutes, so the question is never
 * "how long has this been going" but "has anything happened lately, and is anything still trying".
 */
import { expect, it } from "vitest";
import { cvBuildState, cvWorkVersion, type CvBuildDraft, type CvBuildTask } from "./cv-build-state";

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

  const failed = cvBuildState(draft(), task({ status: "failed", error: "generate_cv exceeded its 1800s deadline", attempts: 28 }), now);
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
