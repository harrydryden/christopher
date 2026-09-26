/**
 * CI: hold the committed evaluation reports to the shipped prompt registry.
 *
 *   pnpm exec tsx scripts/check-evaluation-reports.ts
 *
 * Reads every `docs/evaluations/<name>/report.json` and fails when the prompts that ship have not
 * been graded (scripts/evaluation-report-gate.mjs decides; docs/DEPLOY.md, "Evaluation reports and
 * the prompt set", says what to do about a failure).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { promptSetVersion } from "../packages/ai/src/prompt-registry";
import { checkEvaluationReports } from "./evaluation-report-gate.mjs";

const root = resolve(import.meta.dirname, "..");
const dir = join(root, "docs/evaluations");
const reports = readdirSync(dir, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(dir, entry.name, "report.json")))
  .map(entry => {
    const path = join(dir, entry.name, "report.json");
    return { path: relative(root, path), report: JSON.parse(readFileSync(path, "utf8")) as unknown };
  });
const current = promptSetVersion();
const result = checkEvaluationReports(reports, current);
console.log(`shipped prompt set: ${current}; ${reports.length} committed report(s)`);
for (const note of result.notes) console.log(`note: ${note}`);
for (const problem of result.problems) console.error(`error: ${problem}`);
if (!result.ok) process.exitCode = 1;
