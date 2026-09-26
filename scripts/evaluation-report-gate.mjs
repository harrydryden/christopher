/**
 * The evaluation gate CI runs (scripts/check-evaluation-reports.ts reads the files and the registry;
 * this decides). Every committed `docs/evaluations/<name>/report.json` names the prompt set it was
 * graded at, and the shipped prompts must have been graded:
 *
 *  - a report whose prompt set differs from the shipped registry's `promptSetVersion()` fails,
 *    unless it is marked `unverified: true` — a report kept for the record that no longer vouches
 *    for the shipped prompts, or one written without a live run;
 *  - and at least one report must be at the shipped prompt set, verified or marked unverified, so a
 *    prompt change cannot merge without someone writing down that it was (or was not) evaluated.
 */

/** The prompt set a report says it was graded at, wherever the script that wrote it put it. */
export function reportPromptSet(report) {
  return report?.promptSetVersion ?? report?.reproducibility?.promptSetVersion
    ?? report?.cvPromptsSha256 ?? report?.reproducibility?.cvPromptsSha256 ?? null;
}

/**
 * @param {Array<{ path: string, report: any }>} reports
 * @param {string} current the shipped registry's promptSetVersion()
 * @returns {{ ok: boolean, problems: string[], notes: string[] }}
 */
export function checkEvaluationReports(reports, current) {
  const problems = [];
  const notes = [];
  for (const { path, report } of reports) {
    const graded = reportPromptSet(report);
    const unverified = report?.unverified === true;
    if (graded === current) {
      if (unverified) notes.push(`${path}: at the shipped prompt set ${current}, marked unverified (no live run behind its grade).`);
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
  if (!reports.some(({ report }) => reportPromptSet(report) === current))
    problems.push(`No committed report is at the shipped prompt set ${current}. Write one (docs/DEPLOY.md, "Evaluation reports and the prompt set").`);
  return { ok: problems.length === 0, problems, notes };
}
