import { describe, expect, it } from "vitest";
import type { CvAssessment } from "@christopher/core/cv-assessment";
import { materialiseCv, type CvLibrary } from "@christopher/core/cv";
import {
  cvClaimItems,
  cvTextItems,
  cvEvidenceItems,
} from "@christopher/core/cv-assessment";
import { createCvAssessment } from "@christopher/core/cv-review";
import {
  rubricFixture,
  reviewFixture,
} from "../../../packages/core/test/cv-review-fixture";
import { cvEvaluationRows } from "./cv-evaluation";
const library: CvLibrary = {
  name: "Example",
  contact: "",
  profile: "Operations leader",
  entries: [
    {
      id: "job",
      kind: "experience",
      heading: "Director",
      details: "Led a team",
      confirmedResponsibilities: ["Led a team"],
    },
  ],
};
const content = materialiseCv(library, {
  summary: "Operations leader",
  sections: [{ entryId: "job", bullets: ["Led a team"] }],
  gaps: [],
});
function fixture(): CvAssessment {
  const rubric = rubricFixture("Lead a team");
  const review = reviewFixture({
    rubric,
    cv: cvTextItems(content),
    claims: cvClaimItems(content),
    evidence: cvEvidenceItems(library),
  });
  return createCvAssessment({
    content,
    description: "Lead a team",
    library,
    rubric,
    review,
    model: "test",
    pageCount: 2,
  });
}
describe("unified CV evaluation", () => {
  it.each([
    ["demonstrated", "demonstrated", "None", "Strong", "Green", "—"],
    ["partial", "partial", "Gap", "Good", "Amber", "You"],
    ["missing", "demonstrated", "Improvement", "Strong", "Red", "System"],
    ["unknown", "unknown", "Uncertain", "Weak", "Amber", "You"],
    ["unknown", "demonstrated", "Improvement", "Strong", "Amber", "System"],
  ] as const)(
    "maps %s CV / %s library coverage without inventing a score",
    (status, libraryStatus, change, evidence, experience, owner) => {
      const assessment = fixture();
      Object.assign(assessment.review.matches[0]!, { status, libraryStatus });
      const before = JSON.stringify(assessment);
      expect(cvEvaluationRows(assessment, content)[0]).toMatchObject({
        change,
        evidence,
        experience,
        owner,
      });
      expect(JSON.stringify(assessment)).toBe(before);
    },
  );
  it("does not give green to uncertain or unsupported wording, even if the model calls it demonstrated", () => {
    for (const [status, change, experience] of [
      ["unsupported", "Fact", "Red"],
      ["uncertain", "Uncertain", "Amber"],
    ] as const) {
      const assessment = fixture();
      Object.assign(assessment.review.claims[0]!, {
        status,
        reason: "Confirm the scope.",
      });
      const rows = cvEvaluationRows(assessment, content);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        change,
        experience,
        currentText: [content.summary],
      });
      expect(rows[0]!.suggestion).toContain("issue 2");
      expect(rows[1]!.suggestion).toContain("Confirm the scope.");
    }
  });
  it("keeps uncited factual concerns and writing gaps in the same table", () => {
    const assessment = fixture();
    Object.assign(assessment.review.claims[1]!, {
      status: "unsupported",
      reason: "Team size is not confirmed.",
      evidence: [],
    });
    const rows = cvEvaluationRows(assessment, {
      ...content,
      gaps: ["Provide team size.", "Provide team size."],
    });
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({
      requirement: "Factual accuracy",
      change: "Fact",
      evidence: "None",
      currentText: ["Led a team"],
    });
    expect(rows[2]).toMatchObject({
      change: "Gap",
      suggestion: "Provide team size.",
    });
  });
  it("handles absent requirement/claim reviews conservatively", () => {
    const assessment = fixture();
    assessment.review.claims = [];
    expect(cvEvaluationRows(assessment, content)[0]).toMatchObject({
      change: "Uncertain",
      experience: "Amber",
      owner: "System",
    });
    assessment.review.matches = [];
    expect(cvEvaluationRows(assessment, content)[0]).toMatchObject({
      change: "Uncertain",
      evidence: "None",
      experience: "Amber",
    });
  });
  it("does not show library support without cited evidence", () => {
    const assessment = fixture();
    assessment.review.matches[0]!.libraryEvidence = [];
    expect(cvEvaluationRows(assessment, content)[0]!.evidence).toBe("None");
  });
});
