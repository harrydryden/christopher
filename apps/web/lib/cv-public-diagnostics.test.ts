import { expect, it } from "vitest";
import type { CvBuildFailure } from "@col/core";
import { cvProgressReading, type CvProgressRows } from "./cv-progress";
import { cvViewerBuildState, cvViewerLibraryImportError, cvViewerSkillSuggestionError } from "./cv-public-diagnostics";

const now = new Date("2026-11-01T12:00:00.000Z");
const secret = "SECRET ANTHROPIC HTTP 400 billing token";
const providerFailure: CvBuildFailure = {
  kind: "provider_billing_exhausted", resolvedBy: "user", retryable: false,
  action: "check_provider_billing", message: secret, cause: secret,
};
const rows = (failure: CvBuildFailure = providerFailure, status: CvProgressRows["draft"]["status"] = "failed"): CvProgressRows => ({
  draft: { status, buildStage: "assessing", error: secret, failure,
    createdAt: now, progressAt: now },
  task: { status: status === "failed" ? "failed" : "queued", attempts: 1, maxAttempts: 3,
    error: secret, startedAt: now },
  anyTaskActive: status !== "failed",
  signature: "1:0:2026-11-01T12:00:00.000Z",
  steps: [{ id: "step", seq: 1, attempt: 1, stage: "assessing", motion: "assess_batch", title: secret,
    status: "failed", startedAt: now, finishedAt: now, ms: 1,
    detail: { error: secret, nested: { provider: secret }, reason: secret, claims: 3, pass: "draft" },
    error: secret, failure }],
});

it("keeps provider diagnostics in admin readings and removes them from member HTML and feed models", () => {
  const input = rows();
  const member = cvProgressReading(input, now, "UTC", false);
  const admin = cvProgressReading(input, now, "UTC", true);
  const memberPage = cvViewerBuildState(input.draft, input.task, now, "UTC", false);
  const adminPage = cvViewerBuildState(input.draft, input.task, now, "UTC", true);
  expect(JSON.stringify(member)).not.toContain(secret);
  expect(JSON.stringify(memberPage)).not.toContain(secret);
  expect(member.build?.title).toBe("CV service unavailable");
  expect(member.failure).toBeNull();
  expect(member.steps[0]?.detail).toEqual({ claims: 3, pass: "draft" });
  expect(member.steps[0]?.title).toBe("Checking requirements and claims against your evidence");
  expect(member.steps[0]?.error).toContain("saved work");
  expect(JSON.stringify(admin)).toContain(secret);
  expect(JSON.stringify(adminPage)).toContain(secret);
  expect(admin.failure?.cause).toBe(secret);
});

it("keeps an active retry active and neutral even when its old journal step failed for billing", () => {
  const active = rows({ kind: "overloaded", resolvedBy: "system", retryable: true,
    message: secret, cause: secret, attempt: 1, maxAttempts: 3 }, "generating");
  const member = cvProgressReading(active, now, "UTC", false);
  expect(member.active).toBe(true);
  expect(member.build?.phase).toBe("retrying");
  expect(member.build?.message).toContain("retry automatically");
  expect(JSON.stringify(member)).not.toContain(secret);
  expect(member.steps[0]?.error).toContain("saved work");
});

it("keeps personal budget recovery but no operator billing detail", () => {
  const account = rows({ kind: "budget_exhausted", budgetLimit: "account", resolvedBy: "user",
    retryable: false, action: "raise_budget", message: secret }, "failed");
  const state = cvViewerBuildState(account.draft, account.task, now, "UTC", false);
  expect(state.action).toBe("raise_budget");
  expect(state.message).toContain("monthly AI budget");
  expect(JSON.stringify(state)).not.toContain(secret);
  const day = rows({ kind: "budget_exhausted", budgetLimit: "day", resolvedBy: "user",
    retryable: false, action: "check_deployment_budget", message: secret }, "failed");
  const dayState = cvViewerBuildState(day.draft, day.task, now, "UTC", false);
  expect(dayState.title).toBe("CV service unavailable");
  expect(dayState.message).toContain("CV service is temporarily unavailable");
  expect(JSON.stringify(dayState)).not.toContain(secret);
  expect(JSON.stringify(dayState)).not.toContain("spending limit");
});

it("does not echo stored skill or document errors, including a safe prefix with appended diagnostics", () => {
  expect(cvViewerSkillSuggestionError(secret, false)).not.toContain(secret);
  expect(cvViewerSkillSuggestionError(secret, true)).toBe(secret);
  expect(cvViewerLibraryImportError(`There is no readable text in that PDF. ${secret}`, false)).not.toContain(secret);
  expect(cvViewerLibraryImportError("There is no readable text in that PDF.", false)).toBe("There is no readable text in that PDF.");
  expect(cvViewerLibraryImportError(secret, true)).toBe(secret);
});
