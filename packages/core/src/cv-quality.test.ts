import { describe, expect, it } from "vitest";
import type { CvContent } from "./cv";
import type { CvAssessment } from "./cv-assessment";
import { compareCvQuality, diagnoseCvQuality, improvementWorthwhile, type CvQualityDiagnostics } from "./cv-quality";

const content: CvContent = {
  name: "Example", contact: "", linkedinUrl: "", websiteUrl: "",
  summary: "Operations leader delivering transformation programmes",
  sections: [{ entryId: "job", kind: "experience", heading: "Director", bullets: ["Led a team", "Led a team"] }],
  gaps: [],
};
const assessment = (): CvAssessment => ({
  version: "test", inputHash: "hash", model: "fixture", assessedAt: "2026-09-20T00:00:00Z", pageCount: 2,
  score: 63, availableEvidenceScore: 88,
  rubric: { caveats: [], requirements: [
    { id: "lead", label: "Leadership", quote: "Lead a large team", importance: "essential", category: "experience" },
    { id: "change", label: "Transformation", quote: "Deliver transformation", importance: "desirable", category: "delivery" },
    { id: "loc", label: "Location", quote: "Able to work in London", importance: "essential", category: "logistics" },
  ] },
  review: {
    matches: [
      { requirementId: "lead", status: "demonstrated", libraryStatus: "demonstrated", cvEvidence: [{ id: "profile", quote: "leader" }], libraryEvidence: [{ id: "entry:job", quote: "led" }], reason: "Shown", improvement: "" },
      { requirementId: "change", status: "missing", libraryStatus: "demonstrated", cvEvidence: [], libraryEvidence: [{ id: "entry:job", quote: "transformation" }], reason: "Not used", improvement: "Use it" },
      { requirementId: "loc", status: "unknown", libraryStatus: "unknown", cvEvidence: [], libraryEvidence: [], reason: "Confirm", improvement: "" },
    ],
    claims: [
      { claimId: "profile", status: "supported", evidence: [{ id: "source:profile", quote: "leader" }], reason: "Shown" },
      { claimId: "section:job:0", status: "uncertain", evidence: [], reason: "Confirm" },
    ],
  },
});

describe("CV quality diagnostics", () => {
  it("keeps the compatibility score and separates facts, priorities, opportunities and logistics", () => {
    const result = diagnoseCvQuality(assessment(), content);
    expect(result.coverageScore).toBe(63);
    expect(result.factualSupport).toMatchObject({ score: 50, supported: 1, total: 2, uncertain: 1 });
    expect(result.priorityCoverage).toMatchObject({ score: 67, demonstratedEssential: 1, totalEssential: 1 });
    expect(result.evidencedOpportunityGap).toMatchObject({ count: 1, essential: 0, requirementIds: ["change"] });
    expect(result.unverifiedLogistics).toEqual({ count: 1, requirementIds: ["loc"] });
    expect(result.editorial.repetition).toMatchObject({ kind: "heuristic_editorial_signal", label: "Review" });
    expect(result.editorial.disclaimer).toContain("do not predict hiring outcomes");
  });

  it("does not award priority coverage to wording whose cited claim is unsupported", () => {
    const value = assessment();
    value.review.claims[0] = { ...value.review.claims[0]!, status: "unsupported" };
    const result = diagnoseCvQuality(value, content);
    expect(result.priorityCoverage).toMatchObject({ score: 0, earnedWeight: 0, demonstratedEssential: 0 });
    expect(result.evidencedOpportunityGap).toMatchObject({ requirementIds: ["lead", "change"], weightedPoints: 3 });
    expect(result.editorial.summaryFocus.label).toBe("Review");
  });

  it("uses responsibilities as an explicit fallback and leaves empty dimensions unassessed", () => {
    const value = assessment();
    value.rubric.requirements = [{ ...value.rubric.requirements[0]!, importance: "responsibility" }];
    value.review.matches = [value.review.matches[0]!];
    const fallback = diagnoseCvQuality(value, content);
    expect(fallback.priorityCoverage).toMatchObject({ score: 100, basis: "responsibilities_fallback" });
    value.review.claims = [];
    expect(diagnoseCvQuality(value, content).factualSupport.score).toBeNull();
    value.rubric.requirements[0] = { ...value.rubric.requirements[0]!, category: "logistics" };
    expect(diagnoseCvQuality(value, content).priorityCoverage).toMatchObject({ score: null, basis: "not_assessed" });
  });

  it("accepts only a fully supported improvement with no essential regression", () => {
    const before = assessment();
    const after = assessment();
    after.review.claims = after.review.claims.map((claim) => ({ ...claim, status: "supported" as const }));
    after.review.matches[1] = { ...after.review.matches[1]!, status: "demonstrated" };
    expect(compareCvQuality(before, content, after, content).accept).toBe(true);

    after.review.matches[0] = { ...after.review.matches[0]!, status: "missing" };
    const rejected = compareCvQuality(before, content, after, content);
    expect(rejected.accept).toBe(false);
    expect(rejected.reasons.join(" ")).toContain("regresses");
  });

  it("rejects a coverage improvement while any factual claim remains unverified", () => {
    const after = assessment();
    after.review.matches[1] = { ...after.review.matches[1]!, status: "demonstrated" };
    expect(compareCvQuality(assessment(), content, after, content)).toMatchObject({
      accept: false,
      reasons: ["The rewrite still contains unsupported or uncertain factual claims."],
    });
  });

  it("rejects an empty factual audit or a changed fixed rubric", () => {
    const after = assessment();
    after.review.claims = [];
    after.rubric.requirements[1] = { ...after.rubric.requirements[1]!, label: "Changed" };
    const result = compareCvQuality(assessment(), content, after, content);
    expect(result.accept).toBe(false);
    expect(result.reasons.join(" ")).toContain("different fixed rubric");
    expect(result.reasons.join(" ")).toContain("unsupported or uncertain");
  });
});

describe("the optional improvement's gate", () => {
  const diagnostics = (gap: { count?: number; weightedPoints: number; essential?: number }, availableWeight = 20): CvQualityDiagnostics => {
    const base = diagnoseCvQuality(assessment(), content);
    return {
      ...base,
      priorityCoverage: { ...base.priorityCoverage, availableWeight },
      evidencedOpportunityGap: { count: gap.count ?? 1, weightedPoints: gap.weightedPoints, essential: gap.essential ?? 0, requirementIds: ["x"] },
    };
  };

  it("runs for a gap of two weighted points, fifteen per cent of the weight, or any essential", () => {
    expect(improvementWorthwhile(diagnostics({ weightedPoints: 2 }), 1).worthwhile).toBe(true);
    expect(improvementWorthwhile(diagnostics({ weightedPoints: 1.5 }, 10), 1).worthwhile).toBe(true);
    expect(improvementWorthwhile(diagnostics({ weightedPoints: 1, essential: 1 }), 1).worthwhile).toBe(true);
  });

  it("skips a small gap and names its weight and the headroom", () => {
    const decision = improvementWorthwhile(diagnostics({ weightedPoints: 1 }, 7), 1);
    expect(decision.worthwhile).toBe(false);
    expect(decision.reason).toContain("1 of 7 weighted priority points");
    expect(decision.reason).toContain("100% of its writing budget");
    expect(decision.reason).toContain("too small");
  });

  it("skips a non-essential gap when the baseline had to be written smaller to fit", () => {
    const decision = improvementWorthwhile(diagnostics({ weightedPoints: 4 }), 0.85);
    expect(decision.worthwhile).toBe(false);
    expect(decision.reason).toContain("85% of its writing budget");
    expect(decision.reason).toContain("no headroom");
    expect(improvementWorthwhile(diagnostics({ weightedPoints: 2, essential: 1 }), 0.85).worthwhile).toBe(true);
  });

  it("says nothing was omitted when the gap is empty", () => {
    expect(improvementWorthwhile(diagnostics({ count: 0, weightedPoints: 0 }), 1))
      .toEqual({ worthwhile: false, reason: "No important evidence available in the Library was omitted." });
  });
});
