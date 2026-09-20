import assert from "node:assert/strict";
import test from "node:test";
import { evaluationRequirementIds, gradeEvaluationCase, gradeGeneratedCv } from "./cv-evaluation-grading.mjs";

const rubric = { requirements: [
  { id: "lead", quote: "lead a team of at least ten people" },
  { id: "sql", quote: "use SQL in production reporting" },
  { id: "python", quote: "Preferred: Python" },
] };
const ids = evaluationRequirementIds(rubric);
const assessment = (overrides = {}) => ({
  score: 90,
  review: {
    matches: ["lead", "sql", "python"].map(requirementId => ({ requirementId, status: "demonstrated", libraryStatus: "demonstrated" })),
    claims: [{ claimId: "bullet", status: "supported" }],
  },
  ...overrides,
});

test("rubric intent requires three distinct candidate requirements and excludes benefits", () => {
  assert.deepEqual(ids, { leadership: "lead", sql: "sql", python: "python" });
  assert.throws(() => evaluationRequirementIds({ requirements: rubric.requirements.slice(1) }), /leadership/);
  assert.throws(() => evaluationRequirementIds({ requirements: [
    { id: "combined", quote: "lead a team of at least ten people and use SQL in production reporting with Python" },
  ] }), /distinct/);
  assert.throws(() => evaluationRequirementIds({ requirements: [...rubric.requirements, { id: "perk", quote: "Benefits include flexible working" }] }), /benefits/);
});

test("negative cases must classify the relevant requirement correctly", () => {
  const partial = assessment({ score: 70, review: { ...assessment().review,
    matches: assessment().review.matches.map(match => match.requirementId === "lead" ? { ...match, status: "partial", libraryStatus: "partial" } : match),
  } });
  assert.equal(gradeEvaluationCase({ name: "partial-scope", assessment: partial, requirementIds: ids }), true);
  assert.equal(gradeEvaluationCase({ name: "partial-scope", assessment: { ...partial, review: assessment().review }, requirementIds: ids }), false);

  const negation = assessment({ score: 20, review: { ...assessment().review,
    matches: assessment().review.matches.map(match => match.requirementId === "python" ? match : { ...match, status: "missing", libraryStatus: "missing" }),
  } });
  assert.equal(gradeEvaluationCase({ name: "negation", assessment: negation, requirementIds: ids }), true);
});

test("inflation must flag the exact inflated claim", () => {
  const inflated = assessment({ review: { ...assessment().review, claims: [
    { claimId: "profile", status: "unsupported" }, { claimId: "bullet", status: "supported" },
  ] } });
  assert.equal(gradeEvaluationCase({ name: "unsupported-inflation", assessment: inflated, requirementIds: ids, claimId: "bullet" }), false);
  inflated.review.claims[1].status = "unsupported";
  assert.equal(gradeEvaluationCase({ name: "unsupported-inflation", assessment: inflated, requirementIds: ids, claimId: "bullet" }), true);
});

test("generated CV grading is non-vacuous and requires useful requirement coverage", () => {
  assert.equal(gradeGeneratedCv({ assessment: assessment(), requirementIds: ids, pageCount: 2 }), true);
  assert.equal(gradeGeneratedCv({ assessment: assessment({ score: 79 }), requirementIds: ids, pageCount: 2 }), false);
  assert.equal(gradeGeneratedCv({ assessment: { score: 100, review: { matches: assessment().review.matches, claims: [] } }, requirementIds: ids, pageCount: 1 }), false);
});
