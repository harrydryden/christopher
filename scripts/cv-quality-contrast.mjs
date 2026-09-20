import { sameLibraryRoleContrasts } from "./cv-quality-contrast-fixtures.mjs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const words = (value) => value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const csv = (value) => `"${String(value).replaceAll('"', '""')}"`;

/** Deterministic contrast check: does each version select and lead with the expected source evidence? */
export function gradeSameLibraryContrasts(outputs) {
  const rows = sameLibraryRoleContrasts.map((role) => {
    const output = outputs[role.id] ?? {};
    const text = new Set(words(output.text ?? ""));
    const selected = new Set(output.selectedEvidenceIds ?? []);
    const ownHits = role.priorities.filter((word) => text.has(word)).length;
    const otherHits = sameLibraryRoleContrasts
      .filter((candidate) => candidate.id !== role.id)
      .flatMap((candidate) => candidate.priorities)
      .filter((word) => text.has(word)).length;
    const missingExpected = role.expectedEvidenceIds.filter((id) => !selected.has(id));
    const provenanceUseful = !missingExpected.length && role.expectedEvidenceIds.includes(output.leadingEvidenceId);
    return { roleId: role.id, ownHits, otherHits, vocabularyContrast: ownHits >= 2 && ownHits > otherHits,
      provenanceUseful, missingExpected, leadingEvidenceId: output.leadingEvidenceId ?? null,
      selectedEvidenceIds: [...selected] };
  });
  const distinctPlans = new Set(rows.map((row) => row.selectedEvidenceIds.slice().sort().join("|"))).size === rows.length;
  return { passed: distinctPlans && rows.every((row) => row.provenanceUseful), distinctPlans, rows };
}

/**
 * Export for a future blinded pairwise review. `preferred` is intentionally blank: producing this
 * sheet prepares human review; it does not pretend that review has happened.
 */
export function blindedPairwiseCsv(pairs) {
  const header = ["pair_id", "role", "version_a", "version_b", "preferred", "reviewer_reason"];
  const rows = pairs.map((pair, index) => {
    // Stable alternation prevents every candidate version appearing in the same column.
    const [a, b] = index % 2 ? [pair.candidate, pair.baseline] : [pair.baseline, pair.candidate];
    return [pair.id, pair.role, a, b, "", ""].map(csv).join(",");
  });
  return [header.map(csv).join(","), ...rows].join("\n");
}

// A small export surface for release work: input is a JSON array of pair objects, output is CSV.
// It never calls a model and leaves the review columns blank.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2]) {
  readFile(process.argv[2], "utf8").then(value => {
    const pairs = JSON.parse(value);
    process.stdout.write(`${blindedPairwiseCsv(pairs)}\n`);
  });
}
