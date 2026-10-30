import { createHash } from "node:crypto";
import type { CvContent, CvLibrary } from "./cv";
import { groupCvLibrary } from "./cv";
import type { CvRubric, CvTextItem } from "./cv-assessment";
import { CV_REVIEW_VERSION, cvClaimItems, cvEvidenceItems, cvTextItems } from "./cv-assessment";
import { canonicalJson } from "./cv-review";

/** The factual review input, separate from pagination and appearance. A cache is reusable only
 * when the actual review route, prompt and every claim/evidence/role input still match. */
export function cvSemanticAuditIdentity(input: {
  content: CvContent;
  library: CvLibrary;
  rubric: CvRubric;
  description: string;
  reviewRoute: { model: string; effort: string; serviceTier?: string };
  reviewPromptVersion: string;
  eligibleEvidence?: CvTextItem[];
  sourcePolicy?: string;
}): string {
  const fullLibraryEvidence = cvEvidenceItems(groupCvLibrary(input.library));
  return createHash("sha256").update(canonicalJson({
    reviewContractVersion: CV_REVIEW_VERSION,
    claims: cvClaimItems(input.content),
    printedText: cvTextItems(input.content),
    fullLibraryEvidence,
    eligibleClaimEvidence: input.eligibleEvidence ?? fullLibraryEvidence,
    sourcePolicy: input.sourcePolicy ?? "legacy",
    rubric: input.rubric,
    description: input.description,
    reviewRoute: input.reviewRoute,
    reviewPromptVersion: input.reviewPromptVersion,
  })).digest("hex");
}
