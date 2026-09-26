/**
 * The evaluation gate CI runs (scripts/check-evaluation-reports.ts reads the files and the registry;
 * this decides). Every committed `docs/evaluations/<name>/report.json` names the prompt set it was
 * graded at, and the shipped prompts must have been graded:
 *
 *  - a report whose prompt set differs from the shipped registry's `promptSetVersion()` fails,
 *    unless it is marked `unverified: true` — a report kept for the record that no longer vouches
 *    for the shipped prompts, or one written without a live run;
 *  - a replay report (`kind: "cv-replay"`) at the shipped prompt set must say its rebuild was
 *    published and its grade passed: a report that records a failed or ungraded run does not vouch
 *    for the prompts, whatever prompt set it names;
 *  - at least one report must be at the shipped prompt set, verified or marked unverified, so a
 *    prompt change cannot merge without someone writing down that it was (or was not) evaluated;
 *  - and at least one of those must not be marked unverified: a live run graded the shipped
 *    prompts. No live run can happen in CI, so this is a warning unless `requireVerified` is set
 *    (`AVA_EVAL_GATE_REQUIRE_VERIFIED` in the environment of scripts/check-evaluation-reports.ts),
 *    when it is a problem.
 */

/** The prompt set a report says it was graded at, wherever the script that wrote it put it. */
export function reportPromptSet(report) {
  return report?.promptSetVersion ?? report?.reproducibility?.promptSetVersion
    ?? report?.cvPromptsSha256 ?? report?.reproducibility?.cvPromptsSha256 ?? null;
}

/** Whether `AVA_EVAL_GATE_REQUIRE_VERIFIED` is set: any value but empty, `0` or `false`. */
export function requireVerifiedFromEnv(env = process.env) {
  const value = (env.AVA_EVAL_GATE_REQUIRE_VERIFIED ?? "").trim().toLowerCase();
  return value !== "" && value !== "0" && value !== "false";
}

/**
 * @param {Array<{ path: string, report: any }>} reports
 * @param {string} current the shipped registry's promptSetVersion()
 * @param {{ requireVerified?: boolean }} [options]
 * @returns {{ ok: boolean, problems: string[], warnings: string[], notes: string[] }}
 */
export function checkEvaluationReports(reports, current, options = {}) {
  const problems = [];
  const warnings = [];
  const notes = [];
  for (const { path, report } of reports) {
    const graded = reportPromptSet(report);
    const unverified = report?.unverified === true;
    if (graded === current) {
      if (unverified) notes.push(`${path}: at the shipped prompt set ${current}, marked unverified (no live run behind its grade).`);
      if (report?.kind === "cv-replay") {
        if (report.outcome !== "published")
          problems.push(`${path}: a replay at the shipped prompt set whose rebuild was not published (outcome ${JSON.stringify(report.outcome ?? null)}). Fix the build and re-run the evaluation (docs/DEPLOY.md, "Evaluation reports and the prompt set").`);
        if (report.grade?.passed !== true)
          problems.push(`${path}: a replay at the shipped prompt set whose grade ${report.grade ? "did not pass" : "is missing"}. Fix the regression and re-run the evaluation (docs/DEPLOY.md, "Evaluation reports and the prompt set").`);
      }
      continue;
    }
    if (unverified) {
      notes.push(`${path}: graded at ${graded ?? "an unrecorded prompt set"}, marked unverified; it does not vouch for ${current}.`);
      continue;
    }
    problems.push(graded
      ? `${path}: graded at prompt set ${graded}, but the registry ships ${current}. Re-run the evaluation (docs/DEPLOY.md, "Evaluation reports and the prompt set"), or mark the report "unverified": true.`
      : `${path}: names no prompt set (promptSetVersion or cvPromptsSha256). Re-run it, or mark it "unverified": true.`);
  }
  const shipped = reports.filter(({ report }) => reportPromptSet(report) === current);
  if (!shipped.length)
    problems.push(`No committed report is at the shipped prompt set ${current}. Write one (docs/DEPLOY.md, "Evaluation reports and the prompt set").`);
  else if (!shipped.some(({ report }) => report?.unverified !== true)) {
    const message = `Every committed report at the shipped prompt set ${current} is marked unverified: no live run has graded these prompts. Record and replay a live build before relying on them (docs/DEPLOY.md, "Evaluation reports and the prompt set").`;
    (options.requireVerified ? problems : warnings).push(message);
  }
  return { ok: problems.length === 0, problems, warnings, notes };
}

/**
 * The report whose routes Health compares the stage routes against: the newest replay report at the
 * shipped prompt set, or the newest replay report of all when none is.
 * @param {Array<{ path: string, report: any }>} reports
 */
export function evaluatedReport(reports, current) {
  const replays = reports.filter(({ report }) => report?.kind === "cv-replay" && report.routes && typeof report.at === "string")
    .sort((a, b) => b.report.at.localeCompare(a.report.at));
  return replays.find(({ report }) => reportPromptSet(report) === current) ?? replays[0] ?? null;
}

/**
 * packages/core/src/evaluated-routes.ts, as it must read: the graded route of every CV stage in
 * `found`, beside the registry's default route for it (`defaults`, `{ [id]: { model, effort } }`).
 * Deterministic, so CI can compare it with the committed file byte for byte.
 */
export function renderEvaluatedRoutes(found, defaults) {
  const routes = Object.fromEntries(Object.keys(defaults).sort()
    .filter(id => found?.report.routes[id])
    .map(id => {
      const graded = found.report.routes[id];
      return [id, { model: graded.model, resolvedModel: graded.resolvedModel, effort: graded.effort, defaultModel: defaults[id].model, defaultEffort: defaults[id].effort }];
    }));
  const data = {
    report: found?.path ?? "",
    promptSetVersion: found ? reportPromptSet(found.report) ?? "" : "",
    unverified: found ? found.report.unverified === true : true,
    at: found?.report.at ?? "",
    routes,
  };
  return [
    "// Generated by `pnpm exec tsx scripts/check-evaluation-reports.ts --write` from the committed evaluation",
    "// report named below; CI fails when it no longer matches. Do not edit by hand.",
    'import type { EvaluatedRoutes } from "./stage-route-drift";',
    "",
    "/** The route each CV stage was graded at in the last committed evaluation report. */",
    `export const EVALUATED_ROUTES: EvaluatedRoutes = ${JSON.stringify(data, null, 2)};`,
    "",
  ].join("\n");
}
