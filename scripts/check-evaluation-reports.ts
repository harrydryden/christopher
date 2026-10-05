/**
 * CI: hold the committed evaluation reports to the shipped prompt registry.
 *
 *   pnpm exec tsx scripts/check-evaluation-reports.ts [--write]
 *
 * Reads every `docs/evaluations/<name>/report.json` and fails when the prompts that ship have not
 * been graded. Release qualification sets `COL_EVAL_GATE_REQUIRE_VERIFIED=1` to require a verified
 * published replay; ordinary pull-request CI accepts an explicitly unverified fixture with a
 * warning (scripts/evaluation-report-gate.mjs decides; docs/DEPLOY.md explains failures). It also fails when
 * packages/core/src/evaluated-routes.ts — the graded routes Health compares the `stageRoutes`
 * setting against — no longer matches the newest replay report; `--write` regenerates it.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CV_PROMPT_IDS, PROMPTS, promptSetVersion } from "../packages/ai/src/prompt-registry";
import { checkEvaluationReports, evaluatedReport, renderEvaluatedRoutes, requireVerifiedFromEnv } from "./evaluation-report-gate.mjs";

const root = resolve(import.meta.dirname, "..");
const dir = join(root, "docs/evaluations");
const reports = readdirSync(dir, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(dir, entry.name, "report.json")))
  .map(entry => {
    const path = join(dir, entry.name, "report.json");
    return { path: relative(root, path), report: JSON.parse(readFileSync(path, "utf8")) as unknown };
  });
const current = promptSetVersion();
const requireVerified = requireVerifiedFromEnv();
const result = checkEvaluationReports(reports, current, { requireVerified });
console.log(`shipped prompt set: ${current}; ${reports.length} committed report(s)${requireVerified ? "; a verified report is required (COL_EVAL_GATE_REQUIRE_VERIFIED)" : ""}`);
for (const note of result.notes) console.log(`note: ${note}`);
for (const warning of result.warnings) console.warn(`warning: ${warning} (Set COL_EVAL_GATE_REQUIRE_VERIFIED to make this a failure.)`);

const defaults = Object.fromEntries(CV_PROMPT_IDS.map(id => [id, { model: PROMPTS[id].route.model, effort: PROMPTS[id].route.effort }]));
const routesPath = join(root, "packages/core/src/evaluated-routes.ts");
const expected = renderEvaluatedRoutes(evaluatedReport(reports, current), defaults);
if (process.argv.includes("--write")) {
  writeFileSync(routesPath, expected);
  console.log(`wrote ${relative(root, routesPath)}`);
} else if (!existsSync(routesPath) || readFileSync(routesPath, "utf8") !== expected) {
  result.problems.push(`${relative(root, routesPath)} does not match the newest replay report's routes. Run: pnpm exec tsx scripts/check-evaluation-reports.ts --write`);
}
for (const problem of result.problems) console.error(`error: ${problem}`);
if (result.problems.length) process.exitCode = 1;
