import type { CvContent } from "@col/core/cv";
import type { CvAssessment } from "@col/core/cv-assessment";
import { cvMaxPages } from "@col/core/cv";
import { cvEditorialIssueClaims, diagnoseCvQuality } from "@col/core/cv-quality";
import { cvClaimItems } from "@col/core/cv-assessment";
import { cvContentLinks, CV_PROFILE_ID } from "./cv-content-links";

export type CvReviewAction = { kind: "factual" | "coverage" | "layout" | "editorial";
  text: string; href: string };

/** Specific editing work, ranked below factual assurance and capped to avoid busywork. */
export function cvReviewActions(assessment: CvAssessment, content: CvContent): CvReviewAction[] {
  const actions: CvReviewAction[] = [];
  const editHref = (claimId: string, fallback: string) => {
    const target = cvContentLinks(content, [claimId])[0]?.id;
    return target ? `#${encodeURIComponent(target)}` : fallback;
  };
  const reviewRowHref = (id: string) => `#cv-review-row-${encodeURIComponent(id)}`;
  const claimText = new Map(cvClaimItems(content).map(item => [item.id, item.text]));
  const excerpt = (value: string | undefined) => value ? ` “${value.length > 75 ? `${value.slice(0, 72)}…` : value}”` : "";
  const claim = assessment.review.claims.find(item => item.status !== "supported");
  if (claim) actions.push({ kind: "factual", text: `Review the ${claim.status} claim${excerpt(claimText.get(claim.claimId))} and its evidence before finalising.`,
    href: editHref(claim.claimId, reviewRowHref(`claim:${claim.claimId}`)) });
  const missing = assessment.rubric.requirements.find(item => item.importance === "essential" &&
    assessment.review.matches.find(match => match.requirementId === item.id)?.status !== "demonstrated");
  if (missing) actions.push({ kind: "coverage", text: `Review essential requirement: ${missing.label}. Add confirmed evidence if you have it.`,
    href: reviewRowHref(missing.id) });
  if (assessment.pageCount > cvMaxPages(content.theme)) actions.push({ kind: "layout",
    text: `This PDF is ${assessment.pageCount} pages against your ${cvMaxPages(content.theme)}-page limit. Shorten or summarise it, or deliberately change the limit.`,
    href: "#cv-panel-appearance" });
  const quality = diagnoseCvQuality(assessment, content);
  const issues = cvEditorialIssueClaims(content);
  if (quality.editorial.repetition.label === "Review") actions.push({ kind: "editorial",
    text: `${quality.editorial.repetition.note}${excerpt(claimText.get(issues.repeatedClaimId ?? ""))}`,
    href: editHref(issues.repeatedClaimId ?? "profile", `#${CV_PROFILE_ID}`) });
  if (quality.editorial.concision.label === "Review") actions.push({ kind: "editorial",
    text: `${quality.editorial.concision.note}${excerpt(claimText.get(issues.longClaimId ?? ""))}`,
    href: editHref(issues.longClaimId ?? "profile", `#${CV_PROFILE_ID}`) });
  if (quality.editorial.summaryFocus.label === "Review") actions.push({ kind: "editorial",
    text: quality.editorial.summaryFocus.note, href: `#${CV_PROFILE_ID}` });
  return actions.slice(0, 3);
}
