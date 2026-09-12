import { createHash } from "node:crypto";
import {
  CvContentSchema,
  groupCvLibrary,
  type CvContent,
  type CvLibrary,
} from "./cv";
import { CV_LIMITS } from "./cv-format";
import {
  CV_REVIEW_VERSION,
  CvRubricSchema,
  CvReviewPlanSchema,
  cvClaimItems,
  cvTextItems,
  cvEvidenceItems,
  cvMatchPoints,
  cvRequirementWeight,
  type CvAssessment,
  type CvRubric,
  type CvReviewPlan,
  type CvTextItem,
} from "./cv-assessment";

const normalise = (value: string) =>
  value.normalize("NFKC").replace(/\s+/g, " ").trim();
function anchored(value: string, full: string) {
  return normalise(full).includes(normalise(value));
}
export function validateCvRubric(
  description: string,
  value: unknown,
): CvRubric {
  const rubric = CvRubricSchema.parse(value);
  const ids = new Set<string>(),
    quotes = new Set<string>();
  for (const requirement of rubric.requirements) {
    if (!anchored(requirement.quote, description))
      throw new Error(
        "A scoring requirement is not quoted from the saved job description.",
      );
    const key = normalise(requirement.quote).toLowerCase();
    if (ids.has(requirement.id) || quotes.has(key))
      throw new Error(
        "Scoring requirements must be distinct, without duplicate weighting.",
      );
    // Never build a recruitment score from demographic attributes, even if a page requests it.
    if (
      /\b(gender|ethnicity|race|religion|marital status|sexual orientation|date of birth)\b/i.test(
        requirement.label,
      )
    )
      throw new Error("Demographic attributes cannot be scoring criteria.");
    ids.add(requirement.id);
    quotes.add(key);
  }
  return rubric;
}
function validateQuotes(
  refs: Array<{ id: string; quote: string }>,
  items: CvTextItem[],
) {
  for (const ref of refs) {
    const item = items.find((item) => item.id === ref.id);
    if (!item || !anchored(ref.quote, item.text))
      throw new Error(
        "The assessment cited evidence that is not present in its source.",
      );
  }
}
function exactIds(actual: string[], expected: string[]) {
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    actual.every((id) => expected.includes(id))
  );
}
function cvSectionClaimIds(section: CvContent["sections"][number]) {
  return cvClaimItems({
    name: "",
    contact: "",
    summary: "",
    sections: [section],
    gaps: [],
  })
    .filter((item) => item.id !== "profile")
    .map((item) => item.id);
}
export function validateCvReview(
  rubric: CvRubric,
  content: CvContent,
  library: CvLibrary,
  value: unknown,
): CvReviewPlan {
  const review = CvReviewPlanSchema.parse(value);
  const cv = cvTextItems(content),
    evidence = cvEvidenceItems(library),
    claims = cvClaimItems(content);
  if (
    !exactIds(
      review.matches.map((match) => match.requirementId),
      rubric.requirements.map((item) => item.id),
    )
  )
    throw new Error("Assessment must cover every requirement exactly once.");
  if (
    !exactIds(
      review.claims.map((claim) => claim.claimId),
      claims.map((item) => item.id),
    )
  )
    throw new Error(
      "Factual review must cover every printed claim exactly once.",
    );
  for (const match of review.matches) {
    validateQuotes(match.cvEvidence, cv);
    validateQuotes(match.libraryEvidence, evidence);
    if (cvMatchPoints(match.status) && !match.cvEvidence.length)
      throw new Error("A positive CV match needs a quote from the CV.");
    if (cvMatchPoints(match.libraryStatus) && !match.libraryEvidence.length)
      throw new Error(
        "A positive evidence match needs a confirmed source quote.",
      );
  }
  for (const claim of review.claims) {
    validateQuotes(claim.evidence, evidence);
    if (claim.status === "supported" && !claim.evidence.length)
      throw new Error("A supported claim needs confirmed source evidence.");
    const section = content.sections.find((section) =>
      cvSectionClaimIds(section).includes(claim.claimId),
    );
    if (
      claim.status === "supported" &&
      section &&
      !claim.evidence.some((ref) => ref.id === `entry:${section.entryId}`)
    )
      throw new Error(
        "A role or qualification claim must be grounded in its own evidence block.",
      );
  }
  return review;
}
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}
export function cvReviewHash(
  content: CvContent,
  description: string,
  library: CvLibrary,
): string {
  // Includes appearance: the finalisation gate covers the exact rendered revision too.
  const { fitNotes: _notes, ...printed } = CvContentSchema.parse(content);
  return createHash("sha256")
    .update(
      canonicalJson({
        version: CV_REVIEW_VERSION,
        content: printed,
        description,
        library: groupCvLibrary(library),
      }),
    )
    .digest("hex");
}
export function createCvAssessment(input: {
  content: CvContent;
  description: string;
  library: CvLibrary;
  rubric: unknown;
  review: unknown;
  model: string;
  pageCount: number;
  now?: Date;
}): CvAssessment {
  const library = groupCvLibrary(input.library);
  const rubric = validateCvRubric(input.description, input.rubric);
  const review = validateCvReview(rubric, input.content, library, input.review);
  const total = rubric.requirements.reduce(
    (sum, item) => sum + cvRequirementWeight(item),
    0,
  );
  const score = (field: "status" | "libraryStatus") =>
    Math.round(
      (100 *
        rubric.requirements.reduce((sum, item) => {
          const match = review.matches.find(
            (match) => match.requirementId === item.id,
          )!;
          // Unsupported CV claims cannot earn points, even if they contain the right terms.
          const grounded =
            field === "libraryStatus" ||
            match.cvEvidence.every(
              (ref) =>
                ref.id.endsWith(":heading") ||
                review.claims.find((claim) => claim.claimId === ref.id)
                  ?.status === "supported",
            );
          return (
            sum +
            (grounded ? cvMatchPoints(match[field]) : 0) *
              cvRequirementWeight(item)
          );
        }, 0)) /
        total,
    );
  return {
    version: CV_REVIEW_VERSION,
    inputHash: cvReviewHash(input.content, input.description, library),
    model: input.model,
    assessedAt: (input.now ?? new Date()).toISOString(),
    pageCount: input.pageCount,
    rubric,
    review,
    score: score("status"),
    availableEvidenceScore: score("libraryStatus"),
  };
}
export function cvAssessmentCurrent(
  assessment: CvAssessment | null | undefined,
  content: CvContent,
  description: string,
  library: CvLibrary,
): boolean {
  try {
    return (
      !!assessment &&
      assessment.version === CV_REVIEW_VERSION &&
      assessment.inputHash === cvReviewHash(content, description, library)
    );
  } catch {
    return false;
  }
}
export function assertCvFinalisable(input: {
  content: CvContent;
  jobDescription: string;
  librarySnapshot: CvLibrary;
  assessment?: CvAssessment | null;
}) {
  if (
    !cvAssessmentCurrent(
      input.assessment,
      input.content,
      input.jobDescription,
      input.librarySnapshot,
    )
  )
    throw new Error(
      "Assess this saved revision against the job description before finalising it.",
    );
  const assessment = input.assessment!;
  if (assessment.pageCount < 1 || assessment.pageCount > CV_LIMITS.pages)
    throw new Error("Fit this CV to two pages before finalising it.");
  if (assessment.review.claims.some((claim) => claim.status !== "supported"))
    throw new Error(
      "Resolve the flagged factual claims, then reassess before finalising.",
    );
}
