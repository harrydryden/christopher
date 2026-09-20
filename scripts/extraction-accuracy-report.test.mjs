import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const reportPath = new URL("../docs/live-snapshots/2026-09-20-extraction-accuracy/extraction-accuracy-report.json", import.meta.url);
const afterFixPath = new URL("../docs/live-snapshots/2026-09-20-extraction-accuracy-after-fix/extraction-accuracy-report.json", import.meta.url);
const expandedPath = new URL("../docs/live-snapshots/2026-09-20-extraction-accuracy-expanded-2/extraction-accuracy-report.json", import.meta.url);
const expandedReplayPath = new URL("../docs/live-snapshots/2026-09-20-extraction-accuracy-expanded-replay/extraction-accuracy-report.json", import.meta.url);

test("frozen extraction evidence is identity and field level", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.match(report.classification, /machine-derived/);
  assert.match(report.classification, /not human labels/);
  assert.ok(report.sourceCount >= 6);
  assert.ok(new Set(report.cases.map(item => item.sourceType)).size >= 5);
  for (const item of report.cases) {
    assert.ok(item.responses.every(response => response.sha256 && response.file && response.fetchedAt));
    for (const response of item.responses) {
      const body = await readFile(new URL(`../docs/live-snapshots/2026-09-20-extraction-accuracy/${response.file}`, import.meta.url));
      assert.equal(createHash("sha256").update(body).digest("hex"), response.sha256);
    }
    assert.ok(Array.isArray(item.oracle.identities));
    assert.ok(Array.isArray(item.adapterObservation.identities));
    assert.equal(typeof item.adapterObservation.comparison.precision, "number");
    assert.equal(typeof item.adapterObservation.comparison.recall, "number");
    for (const identity of item.oracle.identities) {
      assert.ok(identity.sourceIdentity);
      assert.ok(identity.title);
      assert.ok(identity.url);
    }
  }
});

test("post-fix report replays the same frozen identities without field mismatches", async () => {
  const before = JSON.parse(await readFile(reportPath, "utf8"));
  const after = JSON.parse(await readFile(afterFixPath, "utf8"));
  assert.equal(after.frozenReplay, true);
  assert.equal(after.summary.identityTotals.tp, before.summary.identityTotals.tp);
  assert.equal(after.summary.identityTotals.fp, 0);
  assert.equal(after.summary.identityTotals.fn, 0);
  assert.equal(after.summary.fieldMismatchCount, 0);
  assert.equal(after.summary.exactFieldAccuracy, 1);
  assert.deepEqual(after.cases.flatMap(item => item.responses.map(response => response.sha256)), before.cases.flatMap(item => item.responses.map(response => response.sha256)));
});

test("expanded evidence includes two complete independently enumerated Workday boards", async () => {
  const report = JSON.parse(await readFile(expandedPath, "utf8"));
  const replay = JSON.parse(await readFile(expandedReplayPath, "utf8"));
  assert.match(report.classification, /machine-derived/);
  assert.match(report.classification, /not human labels/);
  const workday = report.cases.filter(item => item.sourceType === "workday");
  assert.equal(workday.length, 2);
  assert.ok(workday.every(item => item.status === "completed"));
  assert.ok(workday.every(item => item.oracleMethod.includes("Independent offset traversal")));
  assert.ok(workday.every(item => item.oracle.identities.length > 0));
  assert.ok(workday.every(item => item.responses.length > 1));
  assert.equal(report.summary.identityTotals.tp, 3423);
  assert.equal(report.summary.identityTotals.fp, 0);
  assert.equal(report.summary.identityTotals.fn, 0);
  assert.equal(report.summary.exactFieldAccuracy, 1);
  assert.equal(replay.frozenReplay, true);
  assert.deepEqual(
    replay.cases.flatMap(item => item.responses.map(response => response.sha256)),
    report.cases.flatMap(item => item.responses.map(response => response.sha256)),
  );
});
