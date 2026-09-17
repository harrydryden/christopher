import { cvQuoteIsAnchored } from "@christopher/core/cv-review";
import { cvMatchPoints, type CvClaimItem, type CvReviewPlan, type CvRubric, type CvTextItem } from "@christopher/core/cv-assessment";

type Context = { cv: CvTextItem[]; claims: CvClaimItem[]; evidence: CvTextItem[] };

export type CvReviewBatch = { requirements: CvRubric["requirements"]; claims: CvClaimItem[]; claimSources: CvTextItem[] };

/**
 * The batches of an audit: up to `size` requirements and as many claims each, with the sources
 * those claims must cite named explicitly. Every batch is assessed against the complete CV and
 * evidence, which the caller sends once as shared context.
 */
export function cvReviewBatches(input: { rubric: CvRubric; claims: CvClaimItem[]; evidence: CvTextItem[] }, size: number): CvReviewBatch[] {
  const batches: CvReviewBatch[] = [];
  const count = Math.max(input.rubric.requirements.length, input.claims.length);
  for (let offset = 0; offset < count; offset += size) {
    const claims = input.claims.slice(offset, offset + size);
    batches.push({
      requirements: input.rubric.requirements.slice(offset, offset + size),
      claims,
      claimSources: input.evidence.filter(source => claims.some(claim => claim.requiredEvidenceId === source.id)),
    });
  }
  return batches;
}
type Issue = { kind: "cv" | "library" | "claim"; index: number; correction: string };

/** Same exact-quote contract as the final validator; findings may only lose credit. */
export function reviewBatchIssues(review: CvReviewPlan, context: Context): Issue[] {
  const valid = (refs: Array<{ id: string; quote: string }>, items: CvTextItem[]) => refs.every(ref => {
    const item = items.find(item => item.id === ref.id);
    return item && cvQuoteIsAnchored(ref.quote, item.text);
  });
  const issues: Issue[] = [];
  review.matches.forEach((match, index) => {
    if (!valid(match.cvEvidence, context.cv) || (cvMatchPoints(match.status) && !match.cvEvidence.length))
      issues.push({ kind: "cv", index, correction: `${match.requirementId}: cite exact contiguous CV quotes under their supplied IDs for a positive match; otherwise use unknown and no CV evidence.` });
    if (!valid(match.libraryEvidence, context.evidence) || (cvMatchPoints(match.libraryStatus) && !match.libraryEvidence.length))
      issues.push({ kind: "library", index, correction: `${match.requirementId}: cite exact contiguous library quotes under their supplied IDs for positive libraryStatus; otherwise use unknown and no library evidence.` });
  });
  review.claims.forEach((claim, index) => {
    const sourceId = context.claims.find(item => item.id === claim.claimId)?.requiredEvidenceId;
    if (!valid(claim.evidence, context.evidence) || (claim.status === "supported" &&
        (!claim.evidence.length || (sourceId && !claim.evidence.some(ref => ref.id === sourceId)))))
      issues.push({ kind: "claim", index, correction: `${claim.claimId}: supported requires an exact source quote${sourceId ? ` from ${sourceId}` : " from the supplied library"}. Recheck claimSources; otherwise use uncertain or unsupported. Never substitute unrelated evidence.` });
  });
  return issues;
}

/** After one correction attempt, preserve the complete review without accepting invalid support. */
export function markUnverifiedFindings(review: CvReviewPlan, issues: Issue[]): CvReviewPlan {
  const result = structuredClone(review);
  for (const issue of issues) {
    if (issue.kind === "claim") {
      const claim = result.claims[issue.index]!;
      claim.status = "uncertain";
      claim.evidence = [];
      claim.reason = "The automated review could not link this claim to a valid quote from its own saved evidence. Check the wording against the original role, qualification or skill evidence before finalising.";
    } else {
      const match = result.matches[issue.index]!;
      if (issue.kind === "cv") { match.status = "unknown"; match.cvEvidence = []; }
      else { match.libraryStatus = "unknown"; match.libraryEvidence = []; }
      match.reason = "The automated review could not verify its evidence citations for this requirement. No credit is awarded for the unverified finding. Reassess it before relying on the score.";
      match.improvement = "Re-run the assessment to verify the supporting quotes; do not add an unverified claim to the CV.";
    }
  }
  return result;
}
