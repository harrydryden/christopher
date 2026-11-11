import { createHash } from "node:crypto";
import { careerCanonicalJson, type CareerAssertionContext } from "./career-record";

export const CAREER_CONFLICT_RULE_VERSION = 1;

/** Server-side fingerprint of the exact structured group, independent of display order. */
export function careerConflictFingerprint<T extends { id: string; revision: number; subjectId: string;
  context: CareerAssertionContext; status: string; provenance: { kind: string } }>(groupKey: string, rows: T[]): string {
  // A fact revision is immutable and changes on every text, public wording, context or status edit.
  const identity = [CAREER_CONFLICT_RULE_VERSION, groupKey, ...rows.map(row => ({ id: row.id,
    revision: row.revision, subjectId: row.subjectId,
    status: row.status, provenanceKind: row.provenance.kind }))
    .sort((a, b) => a.id.localeCompare(b.id))];
  return createHash("sha256").update(careerCanonicalJson(identity)).digest("hex");
}
