import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function checkCorpus(...selection) {
  const result = spawnSync(process.execPath, ["scripts/live-acceptance.mjs", "--check-corpus", "--ai", "--ai-max-usd", "1", ...selection], {
    cwd: repositoryRoot, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, ANTHROPIC_API_KEY: "" },
  });
  assert.equal(result.error, undefined);
  return { status: result.status, stderr: result.stderr, report: JSON.parse(result.stdout) };
}

test("offline corpus check qualifies the committed composition without a provider key", () => {
  const { status, stderr, report } = checkCorpus();
  assert.equal(status, 0, stderr);
  assert.equal(report.mode, "offline_corpus_composition");
  assert.equal(report.goldenSetCompositionQualified, true);
  assert.equal(report.corpusCoverage.qualifies, true);
  assert.equal(report.corpusCoverage.counts.selectedCases, 31);
  assert.equal(report.corpusCoverage.counts.distinctCompanies, 31);
  assert.equal(report.corpusCoverage.counts.primaryHtml, 14);
  assert.equal(report.corpusCoverage.counts.customHtml, 5);
  assert.equal(report.corpusCoverage.counts.jsHeavy, 2);
  assert.equal(report.corpusCoverage.counts.multiRegionWorkday, 2);
  assert.equal(report.corpusCoverage.counts.landingToExternalBoard, 1);
  assert.equal(report.corpusCoverage.counts.botProtected, 1);
  assert.deepEqual(report.corpusCoverage.atsTypes, ["ashby", "bamboohr", "eightfold", "greenhouse", "lever", "teamtailor", "workable", "workday"]);
  assert.deepEqual(report.corpusCoverage.invalidEvidence, []);
  assert.deepEqual(report.corpusCoverage.missingReasons, []);
  assert.match(report.corpusCoverage.criterionScope, /posting accuracy.*separate evidence/);
});

test("offline corpus check blocks a selected set missing required strata", () => {
  const { status, stderr, report } = checkCorpus("--ids", "anduril");
  assert.equal(status, 2, stderr);
  assert.equal(report.mode, "offline_corpus_composition");
  assert.equal(report.goldenSetCompositionQualified, false);
  assert.equal(report.corpusCoverage.counts.selectedCases, 1);
  assert.equal(report.corpusCoverage.counts.distinctCompanies, 1);
  assert.deepEqual(report.corpusCoverage.atsTypes, ["greenhouse"]);
  assert.deepEqual(report.corpusCoverage.invalidEvidence, []);
  assert.match(report.corpusCoverage.missingReasons.join("\n"), /at least 8 are required/);
  assert.match(report.corpusCoverage.missingReasons.join("\n"), /at least 5 are required/);
  assert.match(report.corpusCoverage.criterionScope, /posting accuracy.*separate evidence/);
});
