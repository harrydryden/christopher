import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("offline corpus check reports current deficiencies with blocked exit code 2", () => {
  const result = spawnSync(process.execPath, ["scripts/live-acceptance.mjs", "--check-corpus", "--ai", "--ai-max-usd", "1"], {
    cwd: repositoryRoot, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, ANTHROPIC_API_KEY: "" },
  });
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "offline_corpus_composition");
  assert.equal(report.goldenSetCompositionQualified, false);
  assert.equal(report.corpusCoverage.counts.selectedCases, 30);
  assert.equal(report.corpusCoverage.counts.primaryHtml, 14);
  assert.equal(report.corpusCoverage.counts.customHtml, 5);
  assert.deepEqual(report.corpusCoverage.atsTypes, ["ashby", "eightfold", "greenhouse", "lever", "teamtailor", "workable", "workday"]);
  assert.match(report.corpusCoverage.criterionScope, /posting accuracy.*separate evidence/);
});
