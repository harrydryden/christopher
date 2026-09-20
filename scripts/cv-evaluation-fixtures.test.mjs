import assert from "node:assert/strict";
import test from "node:test";
import { gradeRepresentativeContent, gradeRepresentativeRequirements, gradeRepresentativeRubric, representativeCvCases } from "./cv-evaluation-fixtures.mjs";

test("representative suite covers the declared risks with synthetic libraries", () => {
  assert.deepEqual(representativeCvCases.map(item => item.name), [
    "multi-role-senior", "sparse-career-changer", "contradictory-negated",
    "invented-metrics-ownership", "malicious-instructions", "long-document-layout",
    "qualifications-structured-skills",
  ]);
  for (const item of representativeCvCases) {
    assert.equal(item.library.name, "Synthetic Candidate");
    assert.ok(item.library.entries.length > 0);
    assert.ok(item.groundTruth.requiredEntryIds.length > 0);
  }
});

test("ground-truth grading is independent of a model assessment", () => {
  const item = representativeCvCases.find(candidate => candidate.name === "invented-metrics-ownership");
  const base = { summary: "Programme co-ordinator", sections: [
    { entryId: "programme-evidence", bullets: ["Supported a transformation programme."] },
    { entryId: "earlier-programme-evidence", bullets: ["Led a team of 12 people."] },
  ] };
  assert.equal(gradeRepresentativeContent(item, base, 1).passed, true);
  const invented = { ...base, sections: [
    { entryId: "programme-evidence", bullets: ["Owned the transformation and saved 35%."] },
    { entryId: "earlier-programme-evidence", bullets: ["Led a team of 12 people."] },
  ] };
  const result = gradeRepresentativeContent(item, invented, 1);
  assert.equal(result.passed, true);
  assert.deepEqual(result.lexicalReview.sort(), ["35%", "Owned the transformation"].sort());
});

test("rubric intents and semantic requirement outcomes are explicit", () => {
  const item = representativeCvCases.find(candidate => candidate.name === "contradictory-negated");
  const rubric = { requirements: [
    { id: "manage", quote: "manage software engineers" },
    { id: "deploy", quote: "deploy services to Kubernetes" },
  ] };
  const rubricGrade = gradeRepresentativeRubric(item, rubric);
  assert.equal(rubricGrade.passed, true);
  const review = { matches: [
    { requirementId: "manage", status: "partial", libraryStatus: "partial" },
    { requirementId: "deploy", status: "missing", libraryStatus: "missing" },
  ] };
  assert.equal(gradeRepresentativeRequirements(item, { review }, rubricGrade.intentIds).passed, true);
  review.matches[1].libraryStatus = "demonstrated";
  assert.equal(gradeRepresentativeRequirements(item, { review }, rubricGrade.intentIds).passed, false);
});

test("ground-truth grading requires every role and the document limit", () => {
  const item = representativeCvCases.find(candidate => candidate.name === "long-document-layout");
  const sections = item.groundTruth.requiredEntryIds.map(entryId => ({ entryId, bullets: ["Grounded text"] }));
  assert.equal(gradeRepresentativeContent(item, { summary: "Leader", sections }, 2).passed, true);
  assert.equal(gradeRepresentativeContent(item, { summary: "Leader", sections: sections.slice(1) }, 2).passed, false);
  assert.equal(gradeRepresentativeContent(item, { summary: "Leader", sections }, 3).passed, false);
});
