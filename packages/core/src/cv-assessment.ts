import { cvSectionHeading, cvSectionTexts, cleanCvText } from "./cv-format";
import { z } from "zod";
import type { CvContent, CvLibrary } from "./cv";

export const CV_REVIEW_VERSION = "2026-09-12.1";
const quote = z.string().trim().min(1).max(1600);
export const CvRubricSchema = z.object({
  requirements: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        label: z.string().min(1).max(250),
        quote,
        importance: z.enum(["essential", "desirable", "responsibility"]),
        category: z.enum([
          "experience",
          "skills",
          "education",
          "delivery",
          "logistics",
        ]),
      }),
    )
    .min(1)
    .max(30),
  caveats: z.array(z.string().max(500)).max(8),
});
export type CvRubric = z.infer<typeof CvRubricSchema>;
const status = z.enum(["demonstrated", "partial", "missing", "unknown"]);
const source = z.object({ id: z.string().min(1).max(180), quote });
export const CvReviewPlanSchema = z.object({
  matches: z
    .array(
      z.object({
        requirementId: z.string().min(1).max(40),
        status,
        libraryStatus: status,
        cvEvidence: z.array(source).max(8),
        libraryEvidence: z.array(source).max(8),
        reason: z.string().min(1).max(700),
        improvement: z.string().max(700),
      }),
    )
    .min(1)
    .max(30),
  claims: z
    .array(
      z.object({
        claimId: z.string().min(1).max(180),
        status: z.enum(["supported", "unsupported", "uncertain"]),
        evidence: z.array(source).max(8),
        reason: z.string().min(1).max(700),
      }),
    )
    .min(1)
    .max(180),
});
export type CvReviewPlan = z.infer<typeof CvReviewPlanSchema>;
export type CvAssessment = {
  version: string;
  inputHash: string;
  model: string;
  assessedAt: string;
  pageCount: number;
  rubric: CvRubric;
  review: CvReviewPlan;
  score: number;
  availableEvidenceScore: number;
};
export type CvJobSource = {
  kind: "company_snapshot" | "user_supplied";
  url: string | null;
  capturedAt: string;
  method?: "direct" | "unknown" | "pasted";
};
export type CvTextItem = { id: string; text: string };

/** Only prose actually printed in the PDF contributes to the CV score. */
export function cvTextItems(content: CvContent): CvTextItem[] {
  return [
    { id: "profile", text: cleanCvText(content.summary) },
    ...content.sections.flatMap((section) => [
      ...(cvSectionHeading(section)
        ? [
            {
              id: `section:${section.entryId}:heading`,
              text: cvSectionHeading(section)!,
            },
          ]
        : []),
      ...cvSectionTexts(section).map((text, index) => ({
        id: `section:${section.entryId}:${index}`,
        text,
      })),
    ]),
  ];
}
export function cvClaimItems(content: CvContent): CvTextItem[] {
  return cvTextItems(content).filter((item) => !item.id.endsWith(":heading"));
}
/** Caller supplies the grouped, confirmed library. Writing preferences are not evidence. */
export function cvEvidenceItems(library: CvLibrary): CvTextItem[] {
  return [
    { id: "source:profile", text: library.profile },
    ...library.entries.map((entry) => ({
      id: `entry:${entry.id}`,
      text: [entry.heading, entry.details, ...(entry.skillItems ?? [])].join(
        "\n",
      ),
    })),
  ];
}
export const cvMatchPoints = (
  value: CvReviewPlan["matches"][number]["status"],
) => (value === "demonstrated" ? 1 : value === "partial" ? 0.5 : 0);
export const cvRequirementWeight = (
  requirement: CvRubric["requirements"][number],
) => (requirement.importance === "essential" ? 2 : 1);
export function cvImprovementOwner(
  match: CvReviewPlan["matches"][number],
): "system" | "user" | "none" {
  if (match.status === "demonstrated") return "none";
  return cvMatchPoints(match.libraryStatus) > cvMatchPoints(match.status) &&
    match.libraryEvidence.length
    ? "system"
    : "user";
}
