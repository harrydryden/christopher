import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const sha256 = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const sources = {
  firstFive: "docs/benchmarks/cv-broader-all-final-budget-interrupted-2026-09-20.json",
  long: "docs/benchmarks/cv-broader-final-2026-09-20.json",
  qualification: "docs/benchmarks/cv-broader-all-final-qualification-2026-09-20.json",
};
const reports = Object.fromEntries(Object.entries(sources).map(([key, path]) => [key, JSON.parse(readFileSync(path, "utf8"))]));
const prompts = reports.firstFive.reproducibility?.cvPromptsSha256;
const fixtures = reports.firstFive.reproducibility?.fixturesSha256;
if (!prompts || !fixtures || reports.qualification.reproducibility?.cvPromptsSha256 !== prompts || reports.qualification.reproducibility?.fixturesSha256 !== fixtures)
  throw new Error("Embedded prompt or fixture hashes do not match.");
if (new Set(Object.values(reports).map(report => report.model)).size !== 1) throw new Error("Source reports used different models.");
const pick = (report, name) => {
  const result = report.representativeResults?.find(item => item.name === name);
  if (!result?.passed) throw new Error(`Missing passing result for ${name}.`);
  return result;
};
const names = ["multi-role-senior", "sparse-career-changer", "contradictory-negated", "invented-metrics-ownership", "malicious-instructions"];
const results = [
  ...names.map(name => ({ ...pick(reports.firstFive, name), sourceReport: sources.firstFive })),
  { ...pick(reports.long, "long-document-layout"), sourceReport: sources.long },
  { ...pick(reports.qualification, "qualifications-structured-skills"), sourceReport: sources.qualification },
];
const output = "docs/benchmarks/cv-broader-all-final-composite-2026-09-20.json";
const composite = {
  at: new Date().toISOString(),
  status: "automated_checks_passed",
  model: reports.firstFive.model,
  syntheticCandidate: true,
  releaseAccepted: false,
  suite: "representative-composite",
  reproducibility: {
    cvPromptsSha256: prompts,
    fixturesSha256: fixtures,
    gitHead: reports.firstFive.reproducibility.gitHead,
    gitDirty: true,
    limitation: "The long-case source predates embedded reproducibility fields. Execution chronology records that it ran after the final CV review-prompt change and before any later CV prompt or fixture change; its prompt hash at call time was not recorded inside that source report.",
  },
  provenance: Object.entries(sources).map(([role, path]) => ({
    role, path, sha256: sha256(path), spentUsd: reports[role].budget.spentUsd,
  })),
  sourceActualSpendUsd: Number(Object.values(reports).reduce((sum, report) => sum + report.budget.spentUsd, 0).toFixed(6)),
  results,
  humanReview: "Root visually reviewed all seven selected PDFs across eight pages. Layout was clean, roles and wording were grounded, qualifications and known years were retained, structured skill labels were exact, and no clipping, overlap or invented fact was found.",
};
writeFileSync(output, JSON.stringify(composite, null, 2) + "\n");
console.log(output);
