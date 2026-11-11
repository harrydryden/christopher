import { createHash } from "node:crypto";
import { canonicalJson } from "@col/core/cv-review";

/** Binds positional proposal IDs to the exact completed extraction shown to the member. */
export function libraryImportProposalKey(row: { processedAt: Date | null; proposal: unknown }): string | null {
  if (!row.processedAt || row.proposal == null) return null;
  return createHash("sha256").update(canonicalJson({
    processedAt: row.processedAt.toISOString(), proposal: row.proposal,
  })).digest("hex");
}
