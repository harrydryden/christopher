import type { CvContent } from "./cv";
import {
  cvClaimItems,
  cvMatchPoints,
  cvRequirementWeight,
  type CvAssessment,
} from "./cv-assessment";

export type EditorialSignal = {
  /** These are deterministic editing prompts, not predictions about recruitment outcomes. */
  kind: "heuristic_editorial_signal";
  score: number;
  label: "Clear" | "Review";
  note: string;
};

export type CvQualityDiagnostics = {
  /** The saved assessment score, retained unchanged for backwards compatibility. */
  coverageScore: number;
  factualSupport: {
    score: number | null;
    supported: number;
    total: number;
    unsupported: number;
    uncertain: number;
  };
  priorityCoverage: {
    score: number | null;
    earnedWeight: number;
    availableWeight: number;
    basis: "stated_priorities" | "responsibilities_fallback" | "not_assessed";
    demonstratedEssential: number;
    totalEssential: number;
  };
  evidencedOpportunityGap: {
    count: number;
    weightedPoints: number;
    requirementIds: string[];
  };
  /** Logistics are reported separately; they do not reduce capability coverage. */
  unverifiedLogistics: {
    count: number;
    requirementIds: string[];
  };
  editorial: {
    disclaimer: "Heuristic editorial signals only — they do not predict hiring outcomes.";
    repetition: EditorialSignal;
    concision: EditorialSignal;
    summaryFocus: EditorialSignal;
  };
};

export type CvQualityComparison = {
  accept: boolean;
  reasons: string[];
  before: CvQualityDiagnostics;
  after: CvQualityDiagnostics;
};

const percentage = (earned: number, available: number) =>
  available ? Math.round((earned / available) * 100) : null;
const editorialPercentage = (earned: number, available: number) => percentage(earned, available) ?? 0;
const words = (value: string) =>
  value.toLowerCase().match(/[a-z0-9][a-z0-9'+-]*/g) ?? [];
const normalise = (value: string) => words(value).join(" ");

function repetitionSignal(content: CvContent): EditorialSignal {
  const items = cvClaimItems(content).map((item) => normalise(item.text)).filter(Boolean);
  const duplicates = items.length - new Set(items).size;
  return {
    kind: "heuristic_editorial_signal",
    score: editorialPercentage(Math.max(0, items.length - duplicates), items.length),
    label: duplicates ? "Review" : "Clear",
    note: duplicates
      ? `${duplicates} repeated ${duplicates === 1 ? "line" : "lines"} may use space without adding evidence.`
      : "No repeated profile or bullet lines detected.",
  };
}

function concisionSignal(content: CvContent): EditorialSignal {
  const items = cvClaimItems(content);
  const long = items.filter((item) => words(item.text).length > 32 || item.text.length > 240).length;
  return {
    kind: "heuristic_editorial_signal",
    score: editorialPercentage(items.length - long, items.length),
    label: long ? "Review" : "Clear",
    note: long
      ? `${long} ${long === 1 ? "line is" : "lines are"} over the editing guide of 32 words or 240 characters.`
      : "Profile and bullet lines are within the editing guide.",
  };
}

function claimSupported(assessment: CvAssessment, id: string): boolean {
  return id.endsWith(":heading") || assessment.review.claims.find((claim) => claim.claimId === id)?.status === "supported";
}

function groundedMatchPoints(assessment: CvAssessment, requirementId: string): number {
  const match = assessment.review.matches.find((item) => item.requirementId === requirementId);
  if (!match || !match.cvEvidence.every((reference) => claimSupported(assessment, reference.id))) return 0;
  return cvMatchPoints(match.status);
}

function priorityRequirements(assessment: CvAssessment) {
  const nonLogistics = assessment.rubric.requirements.filter((item) => item.category !== "logistics");
  const stated = nonLogistics.filter((item) => item.importance !== "responsibility");
  return stated.length
    ? { requirements: stated, basis: "stated_priorities" as const }
    : nonLogistics.length
      ? { requirements: nonLogistics, basis: "responsibilities_fallback" as const }
      : { requirements: [], basis: "not_assessed" as const };
}

function summaryFocusSignal(assessment: CvAssessment): EditorialSignal {
  const priority = priorityRequirements(assessment).requirements;
  const focused = priority.filter((requirement) => {
    const match = assessment.review.matches.find((item) => item.requirementId === requirement.id);
    return !!match && groundedMatchPoints(assessment, requirement.id) > 0 &&
      match.cvEvidence.some((reference) => reference.id === "profile") && claimSupported(assessment, "profile");
  }).length;
  const demonstrated = priority.filter((requirement) => groundedMatchPoints(assessment, requirement.id) > 0).length;
  const target = Math.min(3, demonstrated);
  return {
    kind: "heuristic_editorial_signal",
    score: editorialPercentage(Math.min(focused, target), target),
    label: target > 0 && focused >= target ? "Clear" : "Review",
    note: target === 0
      ? "No supported priority coverage is available to assess the profile's emphasis."
      : focused >= target
        ? "The assessment anchors supported priority coverage in the profile."
        : `The assessment anchors ${focused} of ${target} supported priorities in the profile; review its emphasis.`,
  };
}

export function diagnoseCvQuality(
  assessment: CvAssessment,
  content: CvContent,
): CvQualityDiagnostics {
  const matches = new Map(assessment.review.matches.map((match) => [match.requirementId, match]));
  const priority = priorityRequirements(assessment);
  const capabilityRequirements = priority.requirements;
  const availableWeight = capabilityRequirements.reduce((sum, item) => sum + cvRequirementWeight(item), 0);
  const earnedWeight = capabilityRequirements.reduce((sum, item) =>
    sum + cvRequirementWeight(item) * groundedMatchPoints(assessment, item.id), 0);
  const essentials = capabilityRequirements.filter((item) => item.importance === "essential");
  const demonstratedEssential = essentials.filter((item) => groundedMatchPoints(assessment, item.id) === 1).length;
  const claims = assessment.review.claims;
  const supported = claims.filter((claim) => claim.status === "supported").length;
  const opportunities = capabilityRequirements.filter((item) => {
    const match = matches.get(item.id);
    return !!match && cvMatchPoints(match.libraryStatus) > groundedMatchPoints(assessment, item.id) && match.libraryEvidence.length > 0;
  });
  const logistics = assessment.rubric.requirements.filter((item) => {
    const match = matches.get(item.id);
    return item.category === "logistics" && match?.status !== "demonstrated";
  });

  return {
    coverageScore: assessment.score,
    factualSupport: {
      score: percentage(supported, claims.length),
      supported,
      total: claims.length,
      unsupported: claims.filter((claim) => claim.status === "unsupported").length,
      uncertain: claims.filter((claim) => claim.status === "uncertain").length,
    },
    priorityCoverage: {
      score: percentage(earnedWeight, availableWeight),
      earnedWeight,
      availableWeight,
      basis: priority.basis,
      demonstratedEssential,
      totalEssential: essentials.length,
    },
    evidencedOpportunityGap: {
      count: opportunities.length,
      weightedPoints: opportunities.reduce((sum, item) => {
        const match = matches.get(item.id)!;
        return sum + cvRequirementWeight(item) * (cvMatchPoints(match.libraryStatus) - groundedMatchPoints(assessment, item.id));
      }, 0),
      requirementIds: opportunities.map((item) => item.id),
    },
    unverifiedLogistics: { count: logistics.length, requirementIds: logistics.map((item) => item.id) },
    editorial: {
      disclaimer: "Heuristic editorial signals only — they do not predict hiring outcomes.",
      repetition: repetitionSignal(content),
      concision: concisionSignal(content),
      summaryFocus: summaryFocusSignal(assessment),
    },
  };
}

/**
 * Gate one proposed, bounded rewrite. The caller remains responsible for allowing only one rewrite;
 * this comparison decides whether that candidate is safer and more useful than the saved wording.
 */
export function compareCvQuality(
  beforeAssessment: CvAssessment,
  beforeContent: CvContent,
  afterAssessment: CvAssessment,
  afterContent: CvContent,
): CvQualityComparison {
  const before = diagnoseCvQuality(beforeAssessment, beforeContent);
  const after = diagnoseCvQuality(afterAssessment, afterContent);
  const reasons: string[] = [];
  const fixedRubric = JSON.stringify(beforeAssessment.rubric.requirements) === JSON.stringify(afterAssessment.rubric.requirements);
  if (!fixedRubric)
    reasons.push("The rewrite was assessed against a different fixed rubric.");
  if (!after.factualSupport.total || after.factualSupport.supported !== after.factualSupport.total)
    reasons.push("The rewrite still contains unsupported or uncertain factual claims.");
  const beforeFraction = before.priorityCoverage.availableWeight
    ? before.priorityCoverage.earnedWeight / before.priorityCoverage.availableWeight : 0;
  const afterFraction = after.priorityCoverage.availableWeight
    ? after.priorityCoverage.earnedWeight / after.priorityCoverage.availableWeight : 0;
  if (!fixedRubric || !after.priorityCoverage.availableWeight || afterFraction <= beforeFraction)
    reasons.push("The rewrite does not improve non-logistics priority coverage.");

  const regressed = beforeAssessment.rubric.requirements.filter((requirement) =>
    requirement.importance === "essential" &&
    requirement.category !== "logistics" &&
    groundedMatchPoints(beforeAssessment, requirement.id) === 1 &&
    groundedMatchPoints(afterAssessment, requirement.id) < 1,
  );
  if (regressed.length)
    reasons.push(`The rewrite regresses previously demonstrated essential coverage: ${regressed.map((item) => item.label).join(", ")}.`);
  return { accept: reasons.length === 0, reasons, before, after };
}
