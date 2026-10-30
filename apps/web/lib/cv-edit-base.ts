import { createHash } from "node:crypto";
import { canonicalJson } from "@col/core/cv-review";

/** The saved wording and targeting choices against which the editor's indexed fields were drawn. */
export function cvDraftEditBaseHash(content: unknown, targetingBrief: unknown): string {
  return createHash("sha256").update(canonicalJson({ content, targetingBrief: targetingBrief ?? null })).digest("hex");
}
