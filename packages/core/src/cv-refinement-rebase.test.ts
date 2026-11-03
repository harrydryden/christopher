import { expect, it } from "vitest";
import { CvContentSchema, CvLibrarySchema } from "./cv";
import { CvRefinementSchema, cvEditingTargetsFor, cvRefinementDependencies } from "./cv-editing-modes";
import { cvPreviewRefinementRebase, type CvRefinementRebaseSource } from "./cv-refinement-rebase";
import { rubricFixture } from "../test/cv-review-fixture";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const role = "Lead operations and improve service quality across the organisation with measured results.";
const library = CvLibrarySchema.parse({ name: "Ada", contact: "London", profile: "Operations leader",
  entries: [{ id: "role", kind: "experience", heading: "Operations Manager",
    details: "Reduced backlog by 20%\nImproved reporting cadence",
    confirmedResponsibilities: ["Reduced backlog by 20%", "Improved reporting cadence"] }] });
const content = CvContentSchema.parse({ name: "Ada", contact: "London", summary: "Operations delivery",
  summarySources: ["entry:role:row:0"], sections: [{ entryId: "role", kind: "experience",
    heading: "Operations Manager", bullets: ["Reduced backlog by 20%", "Improved reporting cadence"],
    bulletSources: [["entry:role:row:0"], ["entry:role:row:1"]] }], gaps: [] });
const rubric = rubricFixture(role);
const from: CvRefinementRebaseSource = { id: id(1), descriptionVersionId: id(2),
  content, library, rubric, targets: cvEditingTargetsFor(content, (() => {
    let n = 10; return () => id(n++);
  })()) };
const reordered = CvContentSchema.parse({ ...content, sections: [{ ...content.sections[0]!,
  bullets: [...content.sections[0]!.bullets].reverse(),
  bulletSources: [...content.sections[0]!.bulletSources!].reverse() }] });
const to: CvRefinementRebaseSource = { id: id(3), descriptionVersionId: id(4),
  content: reordered, library, rubric, targets: cvEditingTargetsFor(reordered, (() => {
    let n = 30; return () => id(n++);
  })()) };
const lock = (n: number, type: "summary" | "bullet", targetId: string) => {
  const target = { type, id: targetId };
  return CvRefinementSchema.parse({ id: id(n), version: 1, order: n, kind: "exact_wording",
    target, text: `Exact wording ${n}`, dependencies: {
      descriptionVersionId: from.descriptionVersionId, originBaselineId: from.id,
      ...cvRefinementDependencies({ content: from.content, targets: from.targets,
        library: from.library, descriptionVersionId: from.descriptionVersionId, target }) } });
};

it("maps cited bullets by unique source and owner across a JD version and reordered prose", () => {
  const first = lock(50, "bullet", from.targets.sections[0]!.bulletIds[0]!);
  const second = lock(51, "bullet", from.targets.sections[0]!.bulletIds[1]!);
  const summary = lock(52, "summary", from.targets.summaryId);
  const result = cvPreviewRefinementRebase({ from, to, refinements: [first, second, summary] });
  expect(result).toMatchObject([
    { id: first.id, status: "compatible", target: { type: "bullet", id: to.targets.sections[0]!.bulletIds[1] } },
    { id: second.id, status: "compatible", target: { type: "bullet", id: to.targets.sections[0]!.bulletIds[0] } },
    { id: summary.id, status: "compatible", target: { type: "summary", id: to.targets.summaryId } },
  ]);
  const rebound = CvRefinementSchema.parse({ ...first, version: 2,
    target: result[0]!.status === "compatible" ? result[0]!.target : first.target,
    dependencies: result[0]!.status === "compatible" ? {
      descriptionVersionId: to.descriptionVersionId, originBaselineId: to.id,
      sourceHash: result[0]!.sourceHash, sourceIds: result[0]!.sourceIds } : first.dependencies });
  expect(cvPreviewRefinementRebase({ from, to, refinements: [rebound, second] }))
    .toMatchObject([{ id: first.id, status: "current" }, { id: second.id, status: "compatible" }]);
});

it("refuses ambiguous citations, changed facts, changed role criteria and Manual origin", () => {
  const first = lock(53, "bullet", from.targets.sections[0]!.bulletIds[0]!);
  const ambiguous = { ...to, content: CvContentSchema.parse({ ...to.content,
    sections: [{ ...to.content.sections[0]!, bulletSources: [
      ["entry:role:row:0"], ["entry:role:row:0"]] }] }) };
  expect(cvPreviewRefinementRebase({ from, to: ambiguous, refinements: [first] }))
    .toMatchObject([{ status: "conflict", reason: "ambiguous_target" }]);
  const changedLibrary = CvLibrarySchema.parse({ ...library, entries: [{ ...library.entries[0]!,
    details: "Reduced backlog by 25%\nImproved reporting cadence",
    confirmedResponsibilities: ["Reduced backlog by 25%", "Improved reporting cadence"] }] });
  expect(cvPreviewRefinementRebase({ from, to: { ...to, library: changedLibrary }, refinements: [first] }))
    .toMatchObject([{ status: "conflict", reason: "changed_source" }]);
  expect(cvPreviewRefinementRebase({ from, to: { ...to, rubric: { ...rubric,
    requirements: rubric.requirements.map((requirement, i) => i ? requirement :
      { ...requirement, label: "Different role criterion" }) } }, refinements: [first] }))
    .toMatchObject([{ status: "conflict", reason: "changed_role" }]);
  expect(cvPreviewRefinementRebase({ from, to, refinements: [{ ...first,
    dependencies: { ...first.dependencies, originBaselineId: id(99) } }] }))
    .toMatchObject([{ status: "conflict", reason: "manual_origin" }]);
  expect(cvPreviewRefinementRebase({ from, to, refinements: [{ ...first,
    dependencies: { ...first.dependencies, originBaselineId: null } }] }))
    .toMatchObject([{ status: "conflict", reason: "manual_origin" }]);
  expect(cvPreviewRefinementRebase({ from, to, refinements: [{ ...first,
    dependencies: { descriptionVersionId: from.descriptionVersionId,
      sourceHash: first.dependencies.sourceHash, sourceIds: first.dependencies.sourceIds } }] }))
    .toMatchObject([{ status: "compatible" }]);
});

it("does not treat absent profile evidence on both sides as an unchanged summary anchor", () => {
  const ungroundedLibrary = CvLibrarySchema.parse({ ...library, profile: "" });
  const ungroundedContent = CvContentSchema.parse({ ...content, summarySources: undefined });
  const ungroundedFrom = { ...from, content: ungroundedContent, library: ungroundedLibrary };
  const ungroundedTo = { ...to, content: ungroundedContent, library: ungroundedLibrary };
  const target = { type: "summary" as const, id: ungroundedFrom.targets.summaryId };
  const dependencies = cvRefinementDependencies({ content: ungroundedContent,
    targets: ungroundedFrom.targets, library: ungroundedLibrary,
    descriptionVersionId: ungroundedFrom.descriptionVersionId, target });
  expect(dependencies.sourceIds).toEqual(["source:profile"]);
  const row = CvRefinementSchema.parse({ id: id(59), version: 1, order: 0,
    kind: "exact_wording", target, text: "My wording", dependencies: {
      ...dependencies, descriptionVersionId: ungroundedFrom.descriptionVersionId,
      originBaselineId: ungroundedFrom.id } });
  expect(cvPreviewRefinementRebase({ from: ungroundedFrom, to: ungroundedTo,
    refinements: [row] })).toMatchObject([{ status: "conflict", reason: "changed_source" }]);
});

it("moves a structured targeting rule only with the same original role rubric", () => {
  const structured = { kind: "targeting" as const, choices: {
    entries: [{ entryId: "role", treatment: "feature" as const }],
    presentation: { maxPages: 2, bodySizePt: 12 as const },
    emphasisRequirementIds: ["r1"], acknowledgedEssentialOmissionIds: [],
    requirements: [{ id: "r1", text: "Supported delivery", essential: true }],
  } };
  const target = { type: "selection" as const };
  const row = CvRefinementSchema.parse({ id: id(54), version: 1, order: 0, kind: "structured",
    target, structured, dependencies: { descriptionVersionId: from.descriptionVersionId,
      originBaselineId: from.id,
      ...cvRefinementDependencies({ content: from.content, targets: from.targets,
        library: from.library, descriptionVersionId: from.descriptionVersionId, target, structured }) } });
  expect(cvPreviewRefinementRebase({ from, to, refinements: [row] }))
    .toMatchObject([{ status: "compatible", structured }]);
  expect(cvPreviewRefinementRebase({ from, to: { ...to, rubric: { ...rubric,
    requirements: rubric.requirements.map(requirement => ({ ...requirement,
      quote: "Changed employer requirement" })) } }, refinements: [row] }))
    .toMatchObject([{ status: "conflict", reason: "changed_role" }]);
});
