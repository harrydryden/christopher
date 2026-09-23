import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "docs/benchmarks/extraction-ai-structure-fix-2026-09-20.json");

test("zero-cost A3 regrade preserves source evidence and exposes field mismatches", async () => {
  const before = await readFile(source);
  const directory = await mkdtemp(join(tmpdir(), "ava-a3-regrade-"));
  const output = join(directory, "regraded.json");
  const run = spawnSync("pnpm", ["exec", "tsx", "scripts/evaluate-extraction-ai.ts", "--replay", source, "--output", output], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(run.status, 1, run.stderr || run.stdout);
  const after = await readFile(source);
  assert.equal(createHash("sha256").update(after).digest("hex"), createHash("sha256").update(before).digest("hex"));

  const report = JSON.parse(await readFile(output, "utf8"));
  assert.equal(report.mode, "zero_cost_regrade");
  assert.equal(report.budget.spentUsd, 0);
  assert.deepEqual(report.budget.records, []);
  assert.equal(report.compactInput.truncated, false);
  assert.equal(report.grades.exactIdentityMatch, true);
  assert.equal(report.grades.exactFieldMatch, false);
  assert.equal(report.grades.closureProof, false);
  assert.ok(report.extraction.fields.rawExactMismatches.some(mismatch => mismatch.field === "location"));
  assert.ok(report.extraction.fields.semanticMismatches.some(mismatch => mismatch.field === "location"));
  assert.ok(report.recipe.fields.rawExactMismatches.some(mismatch => mismatch.field === "location"));
  assert.equal(report.recipe.producedRows.length, 22);
  assert.equal(report.sourceProvenance.sha256, "baa3bbde25ac15f2da4d2c9f1eca93be168b48be3ad4fe1e4e6c303b36d2f82e");
});
