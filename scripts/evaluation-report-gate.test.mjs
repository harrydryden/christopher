import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEvaluationReports, reportPromptSet } from "./evaluation-report-gate.mjs";

const at = (path, report) => ({ path, report });

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
