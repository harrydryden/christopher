/**
 * The decisions a CV build makes around its model calls: which rubric it must not pay for again,
 * what a refused budget tells the person, and the figures a motion records.
 */
import { expect, it } from "vitest";
import {
  aiBudgetRefusalMessage,
  assessmentTally,
  callCost,
  reusableCvRubric,
  reusedCvRubric,
  usd,
} from "./cv-build-plan";
import type { CvReviewPlan } from "./cv-assessment";

const description = "Lead operations for a growing team.";
const rubric = (label: string) => ({ label } as unknown);

it("keeps a revision's rubric fixed for its description, preferring what this build already paid for", () => {
  const draft = { jobDescription: description, assessment: { rubric: rubric("own") } };
  const parent = { jobDescription: description, assessment: { rubric: rubric("parent") } };
  // The task's own rubric is the parent revision's, carried so retention cannot move the goalposts.
  expect(reusableCvRubric(draft, parent, rubric("supplied"))).toEqual(rubric("supplied"));
  expect(reusableCvRubric(draft, parent, undefined)).toEqual(rubric("parent"));
  // A parent written against a different description is a different rubric, so it is not inherited.
  expect(reusableCvRubric(draft, { ...parent, jobDescription: "Something else" }, undefined)).toEqual(rubric("own"));
  expect(reusableCvRubric({ jobDescription: description, assessment: null }, undefined, undefined)).toBeUndefined();
});

it("names where a reused rubric came from, so the narrative can say what an attempt skipped", () => {
  const draft = { jobDescription: description, assessment: { rubric: rubric("own") } };
  const parent = { jobDescription: description, assessment: { rubric: rubric("parent") } };
  // This build's own earlier attempt comes first: it is already validated against this description.
  expect(reusedCvRubric({ ...draft, buildCheckpoint: { rubric: rubric("checkpoint") as never } }, parent, undefined))
    .toEqual({ reused: "checkpoint", rubric: rubric("checkpoint") });
  expect(reusedCvRubric(draft, parent, undefined)).toEqual({ reused: "parent", rubric: rubric("parent") });
  expect(reusedCvRubric(draft, undefined, rubric("supplied"))).toEqual({ reused: "parent", rubric: rubric("supplied") });
  expect(reusedCvRubric(draft, undefined, undefined)).toEqual({ reused: "assessment", rubric: rubric("own") });
  expect(reusedCvRubric({ jobDescription: description, assessment: null }, undefined, undefined)).toBeNull();
});

it("tells the person which budget refused the work, what is left of it and how to raise it", () => {
  expect(aiBudgetRefusalMessage("This build", 3.15, { limit: "account", limitUsd: 20, spent: 18.5, held: 0 }))
    .toBe("This build needs about $3.15 of AI budget; your budget of $20 has $1.50 left this month (it resets on the 1st). Raise it on Settings, or ask an administrator.");
  // Capacity held by the account's own calls in flight is the ordinary way to meet this, so it is named.
  expect(aiBudgetRefusalMessage("This build", 3.15, { limit: "account", limitUsd: 20, spent: 14, held: 3.2 }))
    .toBe("This build needs about $3.15 of AI budget; your budget of $20 has $2.80 left this month after $3.20 held by calls in flight (it resets on the 1st). Raise it on Settings, or ask an administrator.");
  // The operator's caps are the operator's to raise, and live somewhere else entirely.
  expect(aiBudgetRefusalMessage("Fit scoring", 0.4, { limit: "day", limitUsd: 10, spent: 9.9, held: 0 }))
    .toBe("Fit scoring needs about $0.40 of AI budget; the deployment's daily AI cap of $10 has $0.10 left. An administrator can raise it in the worker's environment; then retry.");
  expect(aiBudgetRefusalMessage("Company discovery", 0.4, { limit: "discovery", limitUsd: 5, spent: 5, held: 0 }))
    .toContain("the deployment's discovery AI cap of $5 has $0.00 left");
});

it("records what a call cost to the fraction of a cent, and every token it was billed for", () => {
  expect(callCost(undefined)).toEqual({});
  expect(callCost({ costUsd: 0.0018249, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 500 }))
    .toEqual({ usd: 0.0018, tokens: 4700 });
  expect(usd(1 / 3)).toBe(0.3333);
});

it("counts how the requirements landed and how the claims held up", () => {
  const review = {
    matches: [
      { status: "demonstrated" }, { status: "demonstrated" }, { status: "partial" },
      { status: "missing" }, { status: "unknown" },
    ],
    claims: [{ status: "supported" }, { status: "unsupported" }, { status: "uncertain" }, { status: "supported" }],
  } as unknown as CvReviewPlan;
  expect(assessmentTally(review)).toEqual({
    demonstrated: 2, partial: 1, missing: 1, unknown: 1, supported: 2, unsupported: 1, uncertain: 1,
  });
});
