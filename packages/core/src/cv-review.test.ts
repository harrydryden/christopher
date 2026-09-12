import { expect, it } from "vitest";
import { materialiseCv, groupCvLibrary, type CvLibrary } from "./cv";
import {
  createCvAssessment,
  validateCvRubric,
  validateCvReview,
  cvAssessmentCurrent,
  assertCvFinalisable,
} from "./cv-review";
import {
  cvTextItems,
  cvClaimItems,
  cvEvidenceItems,
  cvImprovementOwner,
  type CvReviewPlan,
} from "./cv-assessment";
import { rubricFixture, reviewFixture } from "../test/cv-review-fixture";
const description = "Must lead operations. SQL is desirable.";
const library: CvLibrary = {
  name: "Example",
  contact: "London",
  profile: "Operations leader",
  entries: [
    {
      id: "e",
      kind: "experience",
      heading: "Director",
      details: "Led operations using SQL",
      confirmedResponsibilities: ["Led operations using SQL"],
    },
  ],
};
const content = materialiseCv(library, {
  summary: "Operations leader",
  sections: [{ entryId: "e", bullets: ["Led operations"] }],
  gaps: [],
});
const rubric = {
  requirements: [
    {
      id: "r1",
      label: "Lead operations",
      quote: "Must lead operations.",
      importance: "essential" as const,
      category: "experience" as const,
    },
    {
      id: "r2",
      label: "SQL",
      quote: "SQL is desirable.",
      importance: "desirable" as const,
      category: "skills" as const,
    },
  ],
  caveats: [],
};
function review() {
  return reviewFixture({
    rubric,
    cv: cvTextItems(content),
    claims: cvClaimItems(content),
    evidence: cvEvidenceItems(library),
  });
}
function assess(value = review()) {
  return createCvAssessment({
    content,
    description,
    library,
    rubric,
    review: value,
    model: "test",
    pageCount: 2,
  });
}
it("calculates weighted coverage with no model-supplied score or keyword frequency boost", () => {
  const value = review();
  value.matches[1]!.status = "missing";
  value.matches[1]!.cvEvidence = [];
  expect(assess(value).score).toBe(67);
  value.matches[0]!.status = "partial";
  expect(assess(value).score).toBe(33);
  value.matches[0]!.status = "unknown";
  expect(assess(value).score).toBe(0);
  expect(assess(value).availableEvidenceScore).toBe(100);
  expect(cvImprovementOwner(value.matches[1]!)).toBe("system");
  value.matches[1]!.libraryStatus = "unknown";
  value.matches[1]!.libraryEvidence = [];
  expect(cvImprovementOwner(value.matches[1]!)).toBe("user");
});
it("rejects invented, duplicated or demographically biased requirements", () => {
  expect(() =>
    validateCvRubric(description, rubricFixture("Invented requirement")),
  ).toThrow("not quoted");
  expect(() =>
    validateCvRubric(description, {
      ...rubric,
      requirements: [rubric.requirements[0], rubric.requirements[0]],
    }),
  ).toThrow("distinct");
  expect(() =>
    validateCvRubric(description, {
      ...rubric,
      requirements: [{ ...rubric.requirements[0], label: "Gender" }],
    }),
  ).toThrow("Demographic");
});
it("requires a complete assessment and exact evidence quotes, including every claim", () => {
  const value = review();
  value.matches.pop();
  expect(() => validateCvReview(rubric, content, library, value)).toThrow(
    "every requirement",
  );
  const omitted = review();
  omitted.claims.pop();
  expect(() => assess(omitted)).toThrow("every printed claim");
  const fake = review();
  fake.matches[0]!.cvEvidence[0]!.quote = "Invented CV phrase";
  expect(() => assess(fake)).toThrow("not present");
  const fakeSource = review();
  fakeSource.claims[0]!.evidence[0]!.id = "unconfirmed";
  expect(() => assess(fakeSource)).toThrow("not present");
  const empty = review();
  empty.matches[0]!.cvEvidence = [];
  expect(() => assess(empty)).toThrow("positive CV match");
});
it("denies score credit and finalisation for unsupported claims", () => {
  const value = review();
  value.claims[0]!.status = "unsupported";
  const assessment = assess(value);
  expect(assessment.score).toBe(0);
  expect(() =>
    assertCvFinalisable({
      content,
      jobDescription: description,
      librarySnapshot: library,
      assessment,
    }),
  ).toThrow("flagged factual");
});
it("invalidates stale assessments for wording, theme, evidence or description changes", () => {
  const assessment = assess();
  expect(cvAssessmentCurrent(assessment, content, description, library)).toBe(
    true,
  );
  expect(
    cvAssessmentCurrent(
      assessment,
      { ...content, summary: "Rewritten profile" },
      description,
      library,
    ),
  ).toBe(false);
  expect(
    cvAssessmentCurrent(
      assessment,
      { ...content, theme: { ...content.theme!, primary: "#ffffff" } },
      description,
      library,
    ),
  ).toBe(false);
  expect(
    cvAssessmentCurrent(
      assessment,
      content,
      description + " Changed.",
      library,
    ),
  ).toBe(false);
  expect(
    cvAssessmentCurrent(assessment, content, description, {
      ...library,
      profile: "Changed",
    }),
  ).toBe(false);
  expect(() =>
    assertCvFinalisable({
      content,
      jobDescription: description,
      librarySnapshot: library,
      assessment: { ...assessment, pageCount: 3 },
    }),
  ).toThrow("two pages");
});
it("allows a factually supported low-scoring CV to be reviewed and finalised", () => {
  const value = review();
  value.matches.forEach((match) => {
    match.status = "missing";
    match.cvEvidence = [];
  });
  const assessment = assess(value);
  expect(assessment.score).toBe(0);
  expect(() =>
    assertCvFinalisable({
      content,
      jobDescription: description,
      librarySnapshot: library,
      assessment,
    }),
  ).not.toThrow();
});
it("excludes contact, private notes, industry pills, hidden skill bullets and unconfirmed rows", () => {
  const raw = {
    ...library,
    preferredWording: "Invented metric",
    entries: [
      {
        ...library.entries[0]!,
        details: "Led operations using SQL\nUnconfirmed claim",
      },
    ],
  };
  const text = JSON.stringify(cvEvidenceItems(groupCvLibrary(raw)));
  expect(text).not.toContain("Unconfirmed");
  expect(text).not.toContain("Invented metric");
  expect(text).not.toContain("London");
  const cv = cvTextItems({
    ...content,
    gaps: ["Private note"],
    sections: [
      {
        entryId: "s",
        kind: "skill",
        heading: "Tools",
        skillItems: ["SQL"],
        bullets: ["Hidden bullet"],
        industryDescriptions: ["Industry context"],
      },
    ],
  });
  expect(JSON.stringify(cv)).not.toMatch(
    /Private note|Hidden bullet|Industry context|London/,
  );
});
it("keeps hashes stable across PostgreSQL JSONB key reordering", () => {
  const assessment = assess();
  const reorder = <T>(value: T): T =>
    JSON.parse(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).reverse())
          : item,
      ),
    );
  expect(
    cvAssessmentCurrent(
      assessment,
      reorder(content),
      description,
      reorder(library),
    ),
  ).toBe(true);
});
it("prevents transferring achievements from a different role", () => {
  const other = {
    ...library,
    entries: [...library.entries, { ...library.entries[0]!, id: "other" }],
  };
  const value = review();
  value.claims[1]!.evidence = [
    { id: "entry:other", quote: "Led operations using SQL" },
  ];
  expect(() => validateCvReview(rubric, content, other, value)).toThrow(
    "own evidence block",
  );
});
it("accepts exact one- and two-character technical skill citations", () => {
  const shortLibrary: CvLibrary = {
    name: "Example",
    contact: "",
    profile: "Analyst",
    entries: [
      {
        id: "s",
        kind: "skill",
        heading: "Tools",
        details: "R",
        skillItems: ["R", "AI"],
      },
    ],
  };
  const cv = materialiseCv(shortLibrary, {
    summary: "Analyst",
    sections: [{ entryId: "s", bullets: ["R"], skillItems: ["R", "AI"] }],
    gaps: [],
  });
  const r = rubricFixture("Use R and AI");
  const value = reviewFixture({
    rubric: r,
    cv: cvTextItems(cv),
    claims: cvClaimItems(cv),
    evidence: cvEvidenceItems(shortLibrary),
  });
  value.matches[0]!.cvEvidence = [{ id: "section:s:0", quote: "R" }];
  expect(() => validateCvReview(r, cv, shortLibrary, value)).not.toThrow();
});
