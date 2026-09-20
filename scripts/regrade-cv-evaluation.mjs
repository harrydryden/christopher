import { readFileSync, writeFileSync } from "node:fs";
import { gradeRepresentativeRequirements, representativeCvCases } from "./cv-evaluation-fixtures.mjs";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: node scripts/regrade-cv-evaluation.mjs INPUT OUTPUT");
const report = JSON.parse(readFileSync(input, "utf8"));
report.regradedAt = new Date().toISOString();
report.regradedFrom = input;
report.regradeScope = "Deterministic fixture expectations only; provider responses and original report are unchanged.";
for (const result of report.representativeResults ?? []) {
  const testCase = representativeCvCases.find(item => item.name === result.name);
  if (!testCase || !result.assessment || !result.rubricGroundTruth?.intentIds) continue;
  result.requirementGroundTruth = gradeRepresentativeRequirements(testCase, result.assessment, result.rubricGroundTruth.intentIds);
  result.passed = result.deterministic?.passed === true && result.rubricGroundTruth?.passed === true &&
    result.requirementGroundTruth.passed && result.assessorPassed === true &&
    (result.claimFlags ?? []).every(item => item.passed === true);
  result.status = result.passed ? "passed" : "failed";
}
report.status = (report.representativeResults ?? []).every(item => item.passed) ? "automated_checks_passed" : "failed";
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
