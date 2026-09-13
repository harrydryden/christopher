import type { CvContent } from "@christopher/core/cv";
import {
  cvClaimItems,
  cvImprovementOwner,
  type CvAssessment,
} from "@christopher/core/cv-assessment";

export const CV_CHANGE_TYPES = [
  "None",
  "Fact",
  "Gap",
  "Improvement",
  "Uncertain",
] as const;
export type CvChange = (typeof CV_CHANGE_TYPES)[number];
export type CvEvaluationRow = {
  id: string;
  requirement: string;
  importance?: string;
  currentText: string[];
  change: CvChange;
  suggestion: string;
  owner: "You" | "System" | "—";
  evidence: "None" | "Weak" | "Good" | "Strong";
  experience: "Red" | "Amber" | "Green";
  reason: string;
  companyText?: string;
  sources: string[];
};
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

/** Presentation of the saved assessment only; never generates new claims or changes its score. */
export function cvEvaluationRows(
  assessment: CvAssessment,
  content: CvContent | null,
): CvEvaluationRow[] {
  const claims = new Map(
    assessment.review.claims.map((claim) => [claim.claimId, claim]),
  );
  const texts = new Map(
    content ? cvClaimItems(content).map((item) => [item.id, item.text]) : [],
  );
  const matches = new Map(
    assessment.review.matches.map((match) => [match.requirementId, match]),
  );
  const factualClaims = [...claims.values()].filter(
    (claim) => claim.status !== "supported",
  );
  const factualIssueNumbers = new Map(
    factualClaims.map((claim, index) => [
      claim.claimId,
      assessment.rubric.requirements.length + index + 1,
    ]),
  );
  const rows: CvEvaluationRow[] = assessment.rubric.requirements.map(
    (requirement) => {
      const match = matches.get(requirement.id);
      if (!match)
        return {
          id: requirement.id,
          requirement: requirement.label,
          importance: requirement.importance,
          currentText: [],
          change: "Uncertain",
          suggestion: "Reassess this revision to review this requirement.",
          owner: "System",
          evidence: "None",
          experience: "Amber",
          reason: "No requirement assessment is available.",
          companyText: requirement.quote,
          sources: [],
        };
      const flags = unique(match.cvEvidence.map((ref) => ref.id)).flatMap(
        (id) => {
          const claim = claims.get(id);
          if (!claim || claim.status === "supported") return [];
          return [claim];
        },
      );
      const unsupported = flags.some((claim) => claim.status === "unsupported");
      const unreviewed = match.cvEvidence.some(
        (ref) => !ref.id.endsWith(":heading") && !claims.has(ref.id),
      );
      const uncertain =
        flags.length > 0 || unreviewed || match.status === "unknown";
      const demonstrated =
        match.status === "demonstrated" && match.cvEvidence.length > 0;
      const owner = cvImprovementOwner(match);
      const change: CvChange = unsupported
        ? "Fact"
        : flags.length > 0 || unreviewed
          ? "Uncertain"
          : demonstrated
            ? "None"
            : owner === "system"
              ? "Improvement"
              : uncertain
                ? "Uncertain"
                : "Gap";
      return {
        id: requirement.id,
        requirement: requirement.label,
        importance: requirement.importance,
        currentText: unique(match.cvEvidence.map((ref) => ref.quote)),
        change,
        suggestion: flags.length
          ? `Resolve the factual concern in ${flags.length === 1 ? "issue" : "issues"} ${flags.map((claim) => factualIssueNumbers.get(claim.claimId)).join(", ")}. ${match.improvement || "Confirm the evidence or revise the wording, then reassess."}`
          : unreviewed
            ? "This wording needs factual review. Reassess the saved revision."
            : change === "None"
              ? "No change needed."
              : match.improvement || match.reason,
        owner:
          change === "None"
            ? "—"
            : change === "Improvement" || unreviewed
              ? "System"
              : "You",
        evidence: !match.libraryEvidence.length
          ? "None"
          : match.libraryStatus === "demonstrated"
            ? "Strong"
            : match.libraryStatus === "partial"
              ? "Good"
              : "Weak",
        experience: unsupported
          ? "Red"
          : uncertain
            ? "Amber"
            : demonstrated
              ? "Green"
              : match.status === "partial"
                ? "Amber"
                : "Red",
        reason: match.reason,
        companyText: requirement.quote,
        sources: unique(match.libraryEvidence.map((ref) => ref.quote)),
      };
    },
  );
  // Explain each factual concern once, including those not cited by a requirement.
  for (const claim of factualClaims) {
    rows.push({
      id: `claim:${claim.claimId}`,
      requirement: "Factual accuracy",
      currentText: [texts.get(claim.claimId) ?? "Saved claim text unavailable"],
      change: claim.status === "unsupported" ? "Fact" : "Uncertain",
      suggestion: `${claim.reason} Confirm supporting evidence or revise the wording, then reassess.`,
      owner: "You",
      evidence: claim.evidence.length ? "Weak" : "None",
      experience: claim.status === "unsupported" ? "Red" : "Amber",
      reason: claim.reason,
      sources: unique(claim.evidence.map((ref) => ref.quote)),
    });
  }
  // Authoring gaps have no requirement IDs; retain them without guessing semantic matches.
  for (const [index, gap] of unique(content?.gaps ?? []).entries()) {
    if (rows.some((row) => row.suggestion === gap || row.reason === gap))
      continue;
    rows.push({
      id: `gap:${index}`,
      requirement: "Additional evidence",
      currentText: [],
      change: "Gap",
      suggestion: gap,
      owner: "You",
      evidence: "None",
      experience: "Red",
      reason: "Identified during writing and excluded from the PDF.",
      sources: [],
    });
  }
  return rows;
}
