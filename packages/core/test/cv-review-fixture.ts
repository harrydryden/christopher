// Test doubles validate orchestration and source contracts, not model judgement quality.
import type { CvRubric, CvReviewPlan, CvTextItem } from "../src/cv-assessment";
export function rubricFixture(description: string): CvRubric {
  return {
    requirements: [
      {
        id: "r1",
        label: "Relevant operations experience",
        quote: description.slice(0, 200),
        importance: "essential",
        category: "experience",
      },
    ],
    caveats: [],
  };
}
export function reviewFixture(input: {
  rubric: CvRubric;
  cv: CvTextItem[];
  claims: CvTextItem[];
  evidence: CvTextItem[];
}): CvReviewPlan {
  const ref =
    input.evidence.find((item) => item.id !== "source:profile") ??
    input.evidence[0]!;
  const evidence = [{ id: ref.id, quote: ref.text.slice(0, 200) }];
  return {
    matches: input.rubric.requirements.map((requirement) => ({
      requirementId: requirement.id,
      status: "demonstrated",
      libraryStatus: "demonstrated",
      cvEvidence: [{ id: input.claims[0]!.id, quote: input.claims[0]!.text }],
      libraryEvidence: evidence,
      reason: "Fixture match",
      improvement: "",
    })),
    claims: input.claims.map((claim) => {
      const ownId = claim.id.startsWith("section:")
        ? "entry:" + claim.id.slice(8, claim.id.lastIndexOf(":"))
        : "source:profile";
      const own = input.evidence.find(
        (item) => item.id === ownId && item.text.length,
      );
      return {
        claimId: claim.id,
        status: "supported",
        evidence: own
          ? [{ id: own.id, quote: own.text.slice(0, 200) }]
          : evidence,
        reason: "Fixture support",
      };
    }),
  };
}
