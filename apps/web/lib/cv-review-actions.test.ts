import { expect, it } from "vitest";
import { materialiseCv, type CvLibrary } from "@col/core/cv";
import { cvClaimItems, cvEvidenceItems, cvTextItems } from "@col/core/cv-assessment";
import { createCvAssessment } from "@col/core/cv-review";
import { rubricFixture, reviewFixture } from "../../../packages/core/test/cv-review-fixture";
import { cvReviewActions } from "./cv-review-actions";

it("puts factual and essential gaps ahead of editorial advice and never invents a fourth action", () => {
  const library: CvLibrary = { name: "Ada", contact: "", profile: "Analyst", entries: [
    { id: "e", kind: "experience", heading: "Analyst", details: "Assisted reporting",
      confirmedResponsibilities: ["Assisted reporting"] }] };
  const content = materialiseCv(library, { summary: "Analyst", sections: [
    { entryId: "e", bullets: ["Owned a £10m budget"] }], gaps: [] });
  const description = "Own a budget";
  const rubric = rubricFixture(description);
  const review = reviewFixture({ rubric, cv: cvTextItems(content), claims: cvClaimItems(content),
    evidence: cvEvidenceItems(library) });
  review.claims[1]!.status = "unsupported";
  review.matches[0]!.status = "missing";
  const assessment = createCvAssessment({ content, description, library, rubric, review,
    model: "test", pageCount: 3 });
  const actions = cvReviewActions(assessment, { ...content, theme: { ...(content.theme ?? {}), maxPages: 2 } as typeof content.theme });
  expect(actions).toHaveLength(3);
  expect(actions.map(item => item.kind)).toEqual(["factual", "coverage", "layout"]);
});
