/**
 * The claim memo: an audit's claim verdicts, kept so the re-audit of a revision asks only about the
 * claims the revision changed.
 *
 * A claim verdict is judged against the claim's own source, whatever the role asks for: the same
 * sentence, citing the same Library entry, whose text is the same, under the same rubric caveats,
 * by the same prompt, model and effort, gets the same verdict. So each verdict is filed under the
 * hash of exactly those inputs, and a revision's claim whose hash is already filed is not sent
 * again. Every requirement is still re-assessed: a requirement's verdict depends on the whole CV.
 *
 * The key names the prompt version, the model and the effort of the audit that produced the
 * verdict, so a memo never outlives a prompt-set or route change: a key made under the old ones is
 * simply never asked for. A verdict the audit could not verify (`UNVERIFIED_CLAIM_REASON`) is not
 * a verdict and is never filed: the revision asks about that claim again.
 */
import { createHash } from "node:crypto";
import type { CvClaimItem, CvReviewPlan, CvRubric, CvTextItem } from "@ava/core/cv-assessment";
import { UNVERIFIED_CLAIM_REASON } from "./cv-review-batch";

export type CvClaimVerdict = Omit<CvReviewPlan["claims"][number], "claimId">;
/** Claim verdicts by memo key. */
export type CvClaimMemo = Record<string, CvClaimVerdict>;

/** What an audit's verdicts were produced by, besides their claims: its prompt version and route. */
export interface CvClaimMemoRoute {
  promptVersion: string;
  model: string;
  effort: string;
}

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The rubric as the audit reads it: its requirements and its caveats. */
export function cvRubricHash(rubric: CvRubric): string {
  return sha(rubric).slice(0, 32);
}

/**
 * The memo key of one claim: its text, the source it must cite and that source's text, the rubric,
 * and the prompt version, model and effort. A claim with no required source (the profile) is judged
 * against the whole Library, so the whole Library stands as its source.
 */
export function cvClaimMemoKey(claim: CvClaimItem, evidence: readonly CvTextItem[], rubricHash: string, route: CvClaimMemoRoute): string {
  const source = claim.requiredEvidenceId
    ? evidence.find(item => item.id === claim.requiredEvidenceId)?.text ?? null
    : evidence;
  return sha([claim.text, claim.requiredEvidenceId ?? null, source, rubricHash, route.promptVersion, route.model, route.effort]).slice(0, 40);
}

/** Every claim's memo key, by claim id. */
export function cvClaimMemoKeys(input: { rubric: CvRubric; claims: readonly CvClaimItem[]; evidence: readonly CvTextItem[] }, route: CvClaimMemoRoute): Map<string, string> {
  const rubricHash = cvRubricHash(input.rubric);
  return new Map(input.claims.map(claim => [claim.id, cvClaimMemoKey(claim, input.evidence, rubricHash, route)]));
}

/** A finished review's claim verdicts, filed by the keys of the claims they are about. */
export function cvClaimMemoFrom(review: Pick<CvReviewPlan, "claims">, keys: ReadonlyMap<string, string>): CvClaimMemo {
  const memo: CvClaimMemo = {};
  for (const { claimId, ...verdict } of review.claims) {
    const key = keys.get(claimId);
    if (key && verdict.reason !== UNVERIFIED_CLAIM_REASON) memo[key] = verdict;
  }
  return memo;
}
