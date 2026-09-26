import { cvQuoteIsAnchored } from "@ava/core/cv-review";
import { cvMatchPoints, type CvClaimItem, type CvReviewPlan, type CvRubric, type CvTextItem } from "@ava/core/cv-assessment";

type Context = { cv: CvTextItem[]; claims: CvClaimItem[]; evidence: CvTextItem[] };

export type CvReviewBatch = { requirements: CvRubric["requirements"]; claims: CvClaimItem[]; claimSources: CvTextItem[] };

/**
 * The batches of an audit: as few as keep every batch within `size` requirements and `size`
 * claims, with the requirements and the claims each spread evenly across them so the batches,
 * which run together, take about as long as each other. Each names the sources its claims must
 * cite; every batch is assessed against the complete CV and evidence, sent once as shared context.
 */
export function cvReviewBatches(input: { rubric: CvRubric; claims: CvClaimItem[]; evidence: CvTextItem[] }, size: number): CvReviewBatch[] {
  const count = Math.ceil(Math.max(input.rubric.requirements.length, input.claims.length) / size);
  const share = <T>(items: T[], index: number) => {
    const each = Math.ceil(items.length / count);
    return items.slice(index * each, (index + 1) * each);
  };
  return Array.from({ length: count }, (_, index) => {
    const claims = share(input.claims, index);
    return {
      requirements: share(input.rubric.requirements, index),
      claims,
      claimSources: input.evidence.filter(source => claims.some(claim => claim.requiredEvidenceId === source.id)),
    };
  });
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

/** What a claim says when the audit could not verify its citation: no verdict, so never memoised. */
export const UNVERIFIED_CLAIM_REASON = "The automated review could not link this claim to a valid quote from its own saved evidence. Check the wording against the original role, qualification or skill evidence before finalising.";

/** After one correction attempt, preserve the complete review without accepting invalid support. */
export function markUnverifiedFindings(review: CvReviewPlan, issues: Issue[]): CvReviewPlan {
  const result = structuredClone(review);
  for (const issue of issues) {
    if (issue.kind === "claim") {
      const claim = result.claims[issue.index]!;
      claim.status = "uncertain";
      claim.evidence = [];
      claim.reason = UNVERIFIED_CLAIM_REASON;
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
