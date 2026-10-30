import type { CvContent } from "@col/core/cv";
import type { CvAssessment } from "@col/core/cv-assessment";
import { cvMaxPages } from "@col/core/cv";
import { diagnoseCvQuality } from "@col/core/cv-quality";

export type CvReviewAction = { kind: "factual" | "coverage" | "layout" | "editorial";
  text: string; href: string };

/** Specific editing work, ranked below factual assurance and capped to avoid busywork. */
export function cvReviewActions(assessment: CvAssessment, content: CvContent): CvReviewAction[] {
  const actions: CvReviewAction[] = [];
  const claim = assessment.review.claims.find(item => item.status !== "supported");
  if (claim) actions.push({ kind: "factual", text: `Review the ${claim.status} claim and its evidence before finalising.`,
    href: `#cv-panel-evaluation` });
  const missing = assessment.rubric.requirements.find(item => item.importance === "essential" &&
    assessment.review.matches.find(match => match.requirementId === item.id)?.status !== "demonstrated");
  if (missing) actions.push({ kind: "coverage", text: `Review essential requirement: ${missing.label}. Add confirmed evidence if you have it.`,
    href: "#cv-panel-evaluation" });
  if (assessment.pageCount > cvMaxPages(content.theme)) actions.push({ kind: "layout",
    text: `This PDF is ${assessment.pageCount} pages against your ${cvMaxPages(content.theme)}-page limit. Shorten or summarise it, or deliberately change the limit.`,
    href: "#cv-panel-appearance" });
  const quality = diagnoseCvQuality(assessment, content);
  if (quality.editorial.repetition.label === "Review") actions.push({ kind: "editorial",
    text: quality.editorial.repetition.note, href: "#cv-panel-content" });
  if (quality.editorial.concision.label === "Review") actions.push({ kind: "editorial",
    text: quality.editorial.concision.note, href: "#cv-panel-content" });
  if (quality.editorial.summaryFocus.label === "Review") actions.push({ kind: "editorial",
    text: quality.editorial.summaryFocus.note, href: "#cv-panel-content" });
  return actions.slice(0, 3);
}
