/**
 * What a stopped CV build says, kind by kind.
 *
 * These sentences are the product: they are what the person reads when a build stops, and they
 * decide whether the system tries again on its own. They used to be exercised only by draining a
 * real queue against a real database, so a wording change or a new kind reached the page without
 * anyone reading it. Every kind is pinned here.
 */
import { expect, it } from "vitest";
import {
  AUTHOR_CALL,
  CV_LOST_PLACE_MESSAGE,
  CvBuildStop,
  OUTPUT_LIMIT_ASK,
  REFUSED_ASK,
  REVIEW_CALL,
  RUBRIC_CALL,
  callFailureMessage,
  classifyCvBuildFailure,
  cvBuildFailureFor,
  cvPageLimitMessage,
  isInterruptedError,
} from "./cv-build-failure";
import { CvFitFailure } from "./cv-fit";
import { CvLayoutError } from "./cv-pdf";
import { CV_FAILURE_KINDS, type CvFailureKind } from "./cv-build";

const attempts = { attempt: 1, maxAttempts: 3 };

it("says what a model call that produced nothing usable was doing, in the reader's words", () => {
  expect(callFailureMessage("rate_limited", AUTHOR_CALL))
    .toBe("The model provider asked us to slow down while writing the CV.");
  expect(callFailureMessage("overloaded", RUBRIC_CALL, 529))
    .toBe("The model provider was overloaded while extracting the role's requirements (HTTP 529).");
  expect(callFailureMessage("connection", REVIEW_CALL))
    .toBe("The connection to the model provider dropped while checking the CV against your evidence.");
  expect(callFailureMessage("stalled", AUTHOR_CALL))
    .toBe("The model stopped responding while writing the CV: nothing arrived for fifteen minutes.");
  // The engine says which stall it was: silence, or an answer still unfinished at the ceiling.
  expect(callFailureMessage("stalled", AUTHOR_CALL, undefined, undefined, { reason: "idle", afterMs: 300_000 }))
    .toBe("The model stopped responding while writing the CV: nothing arrived for 5 minutes.");
  expect(callFailureMessage("stalled", REVIEW_CALL, undefined, undefined, { reason: "ceiling", afterMs: 900_000 }))
    .toBe("The model stopped responding while checking the CV against your evidence: the answer was still unfinished after 15 minutes.");
  expect(callFailureMessage("model_access", RUBRIC_CALL, 403))
    .toBe("The CV model could not be reached while extracting the role's requirements (HTTP 403). Check model access and usage in Health, then retry.");
  expect(callFailureMessage("output_limit", AUTHOR_CALL, undefined, "(attempt 2 of 3)"))
    .toBe("The model ran out of room for its answer while writing the CV (attempt 2 of 3).");
  expect(callFailureMessage("refused", AUTHOR_CALL))
    .toBe("The model declined to answer while writing the CV.");
  // Anything else is named by the step it happened in rather than guessed at.
  expect(callFailureMessage("output_invalid", REVIEW_CALL))
    .toBe("The model's answer to the assessment step could not be used.");
});

it("takes a failure that knows its own kind at its word, and keeps its figures", () => {
  const stop = new CvBuildStop("budget_exhausted", "This build needs about $3.15 of AI budget; …");
  expect(classifyCvBuildFailure(stop)).toEqual({ kind: "budget_exhausted", message: stop.message, extra: {} });
  const failure = cvBuildFailureFor(stop, attempts);
  expect(failure).toMatchObject({
    kind: "budget_exhausted", resolvedBy: "user", retryable: false, action: "raise_budget",
    message: stop.message, attempt: 1, maxAttempts: 3,
  });
  // The sentence shown is the sentence thrown, so nothing is duplicated into `cause`.
  expect(failure.cause).toBeUndefined();
});

it("passes the fitter's failures through, with the page limit told in the reader's figures", () => {
  const omitted = new CvFitFailure("output_invalid", "The writer omitted employment or education.", { omitted: ["e"] });
  expect(cvBuildFailureFor(omitted, attempts)).toMatchObject({
    kind: "output_invalid", resolvedBy: "system", retryable: true,
    message: "The writer omitted employment or education.",
  });
  // Three attempts inside one build have been spent, so the fitter's own policy decides instead.
  const shape = new CvFitFailure("output_invalid", "The model repeatedly returned the wrong skill format.",
    { attempts: 3 }, { resolvedBy: "user", retryable: false, action: "choose_model" });
  expect(cvBuildFailureFor(shape, attempts)).toMatchObject({
    kind: "output_invalid", resolvedBy: "user", retryable: false, action: "choose_model",
  });
  const pages = new CvFitFailure("page_limit_unfittable", "The builder could not fit …", { pages: 4, maxPages: 2, attempts: 3 });
  const failure = cvBuildFailureFor(pages, attempts);
  expect(failure.message).toBe(cvPageLimitMessage(4, 2));
  expect(failure.message).toBe("The CV is 4 pages after three attempts; the limit is 2. Remove some evidence in your Library or raise the page limit in Settings.");
  expect(failure).toMatchObject({ kind: "page_limit_unfittable", resolvedBy: "user", action: "shorten_or_raise_pages" });
  // The sentence shown is not the sentence thrown, so Operations keeps the original.
  expect(failure.cause).toBe("The builder could not fit …");
  expect(cvPageLimitMessage(1, 1)).toContain("The CV is 1 page after three attempts");
});

it("names a layout that cannot be drawn, and a worker that lost its place, without reading messages", () => {
  expect(classifyCvBuildFailure(new CvLayoutError("A block is taller than the page."))).toMatchObject({ kind: "page_limit_unfittable" });
  class LeaseLost extends Error {
    readonly interrupted = true as const;
  }
  const lost = new LeaseLost("Task lease lost; refusing stale writes");
  expect(isInterruptedError(lost)).toBe(true);
  expect(isInterruptedError(new Error("Task lease lost; refusing stale writes"))).toBe(false);
  expect(cvBuildFailureFor(lost, attempts)).toMatchObject({
    kind: "worker_interrupted", resolvedBy: "system", retryable: true, message: CV_LOST_PLACE_MESSAGE,
  });
});

it("is honestly unknown about anything it does not recognise, and never shows a database error", () => {
  expect(cvBuildFailureFor(new Error("something nobody has named yet"), attempts)).toMatchObject({
    kind: "unknown", resolvedBy: "user", retryable: false, action: "retry",
    message: "something nobody has named yet",
  });
  const query = cvBuildFailureFor(new Error("Failed query: select * from cv_drafts where id = $1"), attempts);
  expect(query.message).toBe("Could not complete this CV. Please retry.");
  expect(query.cause).toContain("Failed query:");
});

it.each([
  ["output_limit" as const, OUTPUT_LIMIT_ASK, "choose_model"],
  ["refused" as const, REFUSED_ASK, "retry"],
])("lets the system try %s once, then asks the person rather than spending a third attempt", (kind, ask, action) => {
  const thrown = new CvBuildStop(kind, callFailureMessage(kind, AUTHOR_CALL));
  const first = cvBuildFailureFor(thrown, { attempt: 1, maxAttempts: 3 });
  expect(first).toMatchObject({ kind, resolvedBy: "system", retryable: true, message: thrown.message });
  const second = cvBuildFailureFor(thrown, { attempt: 2, maxAttempts: 3 });
  // The kind is unchanged — what happened did not change — so Operations still counts them together.
  expect(second).toMatchObject({ kind, resolvedBy: "user", retryable: false, action, message: ask });
  expect(second.cause).toBe(thrown.message);
});

it("gives every failure kind a policy, so nothing reaches the page without a next move", () => {
  for (const kind of CV_FAILURE_KINDS) {
    const failure = cvBuildFailureFor(new CvBuildStop(kind as CvFailureKind, `stopped: ${kind}`), attempts);
    expect(failure.kind).toBe(kind);
    expect(failure.message).toBe(`stopped: ${kind}`);
    expect(["system", "user"]).toContain(failure.resolvedBy);
    // Either the system is coming back, or the person is told what to do about it.
    expect(failure.retryable || failure.action !== undefined).toBe(true);
  }
});

it("hands a page limit that only removing essential evidence could meet to the person, as a page limit", () => {
  const overflow = new CvFitFailure("page_limit_unfittable", "raw", { pages: 3, maxPages: 2, attempts: 3, essential: true });
  const failure = cvBuildFailureFor(overflow, attempts);
  expect(failure).toMatchObject({ kind: "page_limit_unfittable", resolvedBy: "user", retryable: false, action: "shorten_or_raise_pages" });
  expect(failure.message).toBe("The CV is 3 pages after three attempts; the limit is 2, and shortening it further would remove the only evidence for an essential requirement. Shorten that evidence in your Library or raise the page limit in Settings.");
});

it("says where a build stopped: the failure's own motion and batch first, then the motion the build had open", () => {
  const batch = new CvBuildStop("assessment_incomplete", "Batch 2 missed a claim.", { motion: "assess_batch", batch: 2 });
  expect(cvBuildFailureFor(batch, { ...attempts, motion: "assemble" })).toMatchObject({ motion: "assess_batch", batch: 2 });
  expect(cvBuildFailureFor(new CvBuildStop("stalled", "Stopped."), { ...attempts, motion: "write" })).toMatchObject({ motion: "write" });
  expect(cvBuildFailureFor(new CvBuildStop("stalled", "Stopped."), attempts)).not.toHaveProperty("motion");
});
