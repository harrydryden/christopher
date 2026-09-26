import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEvaluationReports, evaluatedReport, renderEvaluatedRoutes, reportPromptSet, requireVerifiedFromEnv } from "./evaluation-report-gate.mjs";

const at = (path, report) => ({ path, report });

test("names the newest replay report at the shipped prompt set, and renders its routes beside the registry's defaults", () => {
  const route = (effort) => ({ model: "cvModel", resolvedModel: "m1", effort });
  const reports = [
    at("old/report.json", { kind: "cv-replay", at: "2026-09-01T00:00:00Z", promptSetVersion: "old", routes: { "cv.review": route("high") } }),
    at("new/report.json", { kind: "cv-replay", at: "2026-09-20T00:00:00Z", promptSetVersion: "new", routes: { "cv.review": route("medium") } }),
    at("later/report.json", { kind: "cv-replay", at: "2026-09-25T00:00:00Z", promptSetVersion: "old", routes: { "cv.review": route("low") } }),
    at("other/report.json", { at: "2026-09-26T00:00:00Z", promptSetVersion: "new" }),
  ];
  assert.equal(evaluatedReport(reports, "new").path, "new/report.json");
  assert.equal(evaluatedReport(reports, "none").path, "later/report.json");
  const defaults = { "cv.review": { model: "cvModel", effort: "high" }, "cv.rubric": { model: "cvModel", effort: "high" } };
  const text = renderEvaluatedRoutes(evaluatedReport(reports, "new"), defaults);
  assert.match(text, /"report": "new\/report.json"/);
  assert.match(text, /"cv.review": \{\n\s+"model": "cvModel",\n\s+"resolvedModel": "m1",\n\s+"effort": "medium",\n\s+"defaultModel": "cvModel",\n\s+"defaultEffort": "high"/);
  assert.doesNotMatch(text, /cv\.rubric/);
  // Deterministic, so CI can compare it with the committed file byte for byte.
  assert.equal(text, renderEvaluatedRoutes(evaluatedReport(reports, "new"), defaults));
});

test("passes when a report is graded at the shipped prompt set", () => {
  const result = checkEvaluationReports([at("a/report.json", { promptSetVersion: "abc" })], "abc");
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test("fails a report graded at another prompt set unless it is marked unverified", () => {
  const stale = checkEvaluationReports([at("a/report.json", { promptSetVersion: "abc" }), at("b/report.json", { promptSetVersion: "new" })], "new");
  assert.equal(stale.ok, false);
  assert.match(stale.problems[0], /a\/report\.json: graded at prompt set abc, but the registry ships new/);
  const marked = checkEvaluationReports([at("a/report.json", { promptSetVersion: "abc", unverified: true }), at("b/report.json", { promptSetVersion: "new" })], "new");
  assert.equal(marked.ok, true);
  assert.equal(marked.notes.length, 1);
});

test("fails when no report is at the shipped prompt set, however the others are marked", () => {
  const result = checkEvaluationReports([at("a/report.json", { promptSetVersion: "abc", unverified: true })], "new");
  assert.equal(result.ok, false);
  assert.match(result.problems.at(-1), /No committed report is at the shipped prompt set new/);
});

test("an unverified report at the shipped prompt set satisfies the gate, and says so", () => {
  const result = checkEvaluationReports([at("a/report.json", { promptSetVersion: "new", unverified: true })], "new");
  assert.equal(result.ok, true);
  assert.match(result.notes[0], /marked unverified/);
});

test("reads the prompt set wherever an evaluation script wrote it, and fails a report that names none", () => {
  assert.equal(reportPromptSet({ reproducibility: { cvPromptsSha256: "f00" } }), "f00");
  assert.equal(reportPromptSet({ reproducibility: { promptSetVersion: "p" } }), "p");
  const result = checkEvaluationReports([at("a/report.json", {}), at("b/report.json", { promptSetVersion: "x" })], "x");
  assert.match(result.problems[0], /names no prompt set/);
});

test("fails a replay report at the shipped prompt set whose rebuild failed or whose grade did not pass", () => {
  const passed = { kind: "cv-replay", promptSetVersion: "new", outcome: "published", grade: { passed: true } };
  assert.equal(checkEvaluationReports([at("a/report.json", passed)], "new").ok, true);
  const failedGrade = checkEvaluationReports([at("a/report.json", { ...passed, grade: { passed: false } })], "new");
  assert.equal(failedGrade.ok, false);
  assert.match(failedGrade.problems[0], /a\/report\.json: a replay at the shipped prompt set whose grade did not pass/);
  const ungraded = checkEvaluationReports([at("a/report.json", { ...passed, grade: undefined })], "new");
  assert.match(ungraded.problems[0], /grade is missing/);
  const failedBuild = checkEvaluationReports([at("a/report.json", { ...passed, outcome: "failed" })], "new");
  assert.equal(failedBuild.ok, false);
  assert.match(failedBuild.problems[0], /rebuild was not published \(outcome "failed"\)/);
  // Marking it unverified does not excuse a failed run at the shipped prompt set.
  assert.equal(checkEvaluationReports([at("a/report.json", { ...passed, unverified: true, grade: { passed: false } })], "new").ok, false);
});

test("warns when every report at the shipped prompt set is unverified, and fails when a verified one is required", () => {
  const unverified = [at("a/report.json", { kind: "cv-replay", promptSetVersion: "new", unverified: true, outcome: "published", grade: { passed: true } })];
  const warned = checkEvaluationReports(unverified, "new");
  assert.equal(warned.ok, true);
  assert.match(warned.warnings[0], /Every committed report at the shipped prompt set new is marked unverified/);
  const required = checkEvaluationReports(unverified, "new", { requireVerified: true });
  assert.equal(required.ok, false);
  assert.match(required.problems[0], /marked unverified/);
  const verified = checkEvaluationReports([...unverified, at("b/report.json", { promptSetVersion: "new" })], "new", { requireVerified: true });
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.warnings, []);
  assert.equal(requireVerifiedFromEnv({}), false);
  assert.equal(requireVerifiedFromEnv({ AVA_EVAL_GATE_REQUIRE_VERIFIED: "0" }), false);
  assert.equal(requireVerifiedFromEnv({ AVA_EVAL_GATE_REQUIRE_VERIFIED: "1" }), true);
});
