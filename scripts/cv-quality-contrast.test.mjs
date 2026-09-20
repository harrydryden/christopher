import assert from "node:assert/strict";
import test from "node:test";
import { blindedPairwiseCsv, gradeSameLibraryContrasts } from "./cv-quality-contrast.mjs";

test("the same library produces useful, role-specific contrasts", () => {
  const result = gradeSameLibraryContrasts({
    "strategy-director": { text: "Set portfolio investment priorities across markets and launch growth channels.", selectedEvidenceIds: ["portfolio", "launch"], leadingEvidenceId: "portfolio" },
    "operations-director": { text: "Led a team through operations delivery and governance for a new channel.", selectedEvidenceIds: ["launch", "people", "risk"], leadingEvidenceId: "people" },
    "analytics-lead": { text: "Built SQL reporting and analytics that accelerated decisions.", selectedEvidenceIds: ["analytics"], leadingEvidenceId: "analytics" },
  });
  assert.equal(result.passed, true);
  assert.equal(result.rows.length, 3);
});

test("generic wording fails contrast and the blinded export records no invented verdict", () => {
  const generic = { text: "Experienced leader who delivered results with stakeholders.", selectedEvidenceIds: ["people"], leadingEvidenceId: "people" };
  assert.equal(gradeSameLibraryContrasts(Object.fromEntries([
    "strategy-director", "operations-director", "analytics-lead",
  ].map((id) => [id, generic]))).passed, false);

  // Vocabulary is useful diagnosis, but cannot make a result pass without source provenance.
  const keywordsOnly = gradeSameLibraryContrasts({
    "strategy-director": { text: "portfolio investment markets growth", selectedEvidenceIds: [], leadingEvidenceId: null },
    "operations-director": { text: "operations delivery team governance", selectedEvidenceIds: [], leadingEvidenceId: null },
    "analytics-lead": { text: "sql reporting decisions analytics", selectedEvidenceIds: [], leadingEvidenceId: null },
  });
  assert.equal(keywordsOnly.rows.every((row) => row.vocabularyContrast), true);
  assert.equal(keywordsOnly.passed, false);

  const output = blindedPairwiseCsv([{ id: "pair-1", role: "Strategy Director", baseline: generic, candidate: "Portfolio leader" }]);
  assert.match(output, /"preferred","reviewer_reason"/);
  assert.match(output, /,"",""$/);
});
