import { expect, it } from "vitest";
import { materialiseCv, type CvLibrary } from "@christopher/core/cv";
import { cvClaimItems, cvTextItems, cvEvidenceItems } from "@christopher/core/cv-assessment";
import { createCvAssessment, validateCvReview } from "@christopher/core/cv-review";
import { rubricFixture, reviewFixture } from "../../core/test/cv-review-fixture";
import { cvReviewBatches, reviewBatchIssues, markUnverifiedFindings } from "./cv-review-batch";

const description = "Must lead operations";
const library: CvLibrary = { name: "Example", contact: "", profile: "Operations leader", entries: [
  { id: "role:1", kind: "experience", heading: "Director", details: "Led operations using SQL", confirmedResponsibilities: ["Led operations using SQL"] },
] };
const content = materialiseCv(library, { summary: "Operations leader", sections: [{ entryId: "role:1", bullets: ["Led operations"] }], gaps: [] });
const rubric = rubricFixture(description);
const context = { rubric, cv: cvTextItems(content), claims: cvClaimItems(content), evidence: cvEvidenceItems(library) };

it("leaves complete, correctly cited reviews unchanged", () => {
  const review = reviewFixture(context);
  expect(reviewBatchIssues(review, context)).toEqual([]);
  expect(markUnverifiedFindings(review, [])).toEqual(review);
});

it("flags unverified CV, library and own-block citations without awarding credit or weakening the final validator", () => {
  const review = reviewFixture(context);
  review.matches[0]!.cvEvidence[0]!.quote = "Invented achievement";
  review.matches[0]!.libraryEvidence[0]!.id = "entry:foreign";
  review.claims[1]!.evidence = [{ id: "source:profile", quote: "Operations leader" }];
  expect(() => validateCvReview(rubric, content, library, review)).toThrow();
  const issues = reviewBatchIssues(review, context);
  expect(issues.map(issue => issue.kind)).toEqual(["cv", "library", "claim"]);
  const conservative = markUnverifiedFindings(review, issues);
  expect(conservative.claims[1]!.status).toBe("uncertain");
  expect(conservative.claims[1]!.reason).toContain("automated review");
  expect(conservative.matches[0]!.reason).toContain("No credit");
  expect(review.claims[1]!.status).toBe("supported");
  const assessment = createCvAssessment({ content, library, description, rubric, review: conservative, model: "test", pageCount: 2 });
  expect(assessment.score).toBe(0);
  expect(assessment.availableEvidenceScore).toBe(0);
});

it("catches missing positive evidence and shares the final validator's whitespace-normalised quote rules", () => {
  const review = reviewFixture(context);
  review.matches[0]!.cvEvidence[0]!.quote = "Operations\nleader";
  expect(reviewBatchIssues(review, context)).toEqual([]);
  review.matches[0]!.cvEvidence = [];
  review.matches[0]!.libraryEvidence = [];
  review.claims[0]!.evidence = [];
  expect(reviewBatchIssues(review, context).map(issue => issue.kind)).toEqual(["cv", "library", "claim"]);
});

it("spreads an audit's requirements and claims evenly over as few batches as the size allows, naming each claim's required source", () => {
  const requirements = Array.from({ length: 19 }, (_, i) => ({ ...rubric.requirements[0]!, id: `r${i}` }));
  const claims = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, text: "Led operations", requiredEvidenceId: i >= 3 ? "entry:role:1" : undefined }));
  const evidence = [{ id: "source:profile", text: "Operations leader" }, { id: "entry:role:1", text: "Led operations using SQL" }];
  const batches = cvReviewBatches({ rubric: { ...rubric, requirements }, claims, evidence }, 8);
  expect(batches.map(batch => [batch.requirements.length, batch.claims.length])).toEqual([[7, 2], [7, 2], [5, 1]]);
  expect(batches[0]!.claimSources).toEqual([]);
  expect(batches[1]!.claimSources).toEqual([evidence[1]]);
  expect(batches[2]!.claimSources).toEqual([evidence[1]]);
  expect(cvReviewBatches({ rubric: { ...rubric, requirements: requirements.slice(0, 9) }, claims: Array.from({ length: 22 }, (_, i) => ({ id: `c${i}`, text: "x" })), evidence }, 8)
    .map(batch => [batch.requirements.length, batch.claims.length])).toEqual([[3, 8], [3, 8], [3, 6]]);
  expect(cvReviewBatches({ rubric: { ...rubric, requirements: requirements.slice(0, 2) }, claims: Array.from({ length: 17 }, (_, i) => ({ id: `c${i}`, text: "x" })), evidence }, 8)).toHaveLength(3);
});
