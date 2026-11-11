import { expect, it } from "vitest";
import { CvRefinementSchema, cvEditingTargetsFor, cvProjectRefinements,
  cvRefineWritingLibrary, cvProjectSkillSelection, cvRefinementDependencies,
  cvApplyGeneratedStructure, cvApplyGeneratedExactLocks } from "./cv-editing-modes";
import { cvTailoringEvidence } from "./cv-tailoring";

const id = () => crypto.randomUUID();
const content = { name: "Ada", contact: "London", summary: "Analyst", gaps: [], sections: [
  { entryId: "role", kind: "experience" as const, heading: "Analyst", bullets: ["Used Excel"] }] };
const library = { name: "Ada", contact: "London", profile: "", entries: [
  { id: "role", kind: "experience" as const, heading: "Analyst", details: "Used Excel", confirmedResponsibilities: ["Used Excel"] } ],
  careerProjection: { version: 1, presentation: "chronological" as const, display: {}, sourceMap: {} } };

it("replays selected skills with stable targets, source markers and reset without losing the Auto source", () => {
  const targets = cvEditingTargetsFor(content, id);
  const sectionId = id(), itemId = id(), bulletId = id(), runId = id(), entryId = `suggested-skill-${id()}`;
  const choice = { kind: "skill_selection" as const, runId, careerVersion: 2, sections: [
    { entryId, sectionId, heading: "Data tools", items: [{ id: itemId, bulletId, label: "Excel",
      sourceId: "entry:role:row:0", quote: "Used Excel", sourceRef: {
        recordId: id(), recordRevision: 1, assertionId: id(), assertionRevision: 1,
        publicText: false, origin: "accepted_suggestion" as const } }] }] };
  const sourceHash = "a".repeat(64), descriptionVersionId = id();
  const row = CvRefinementSchema.parse({ id: id(), version: 1, order: 0, kind: "structured",
    target: { type: "selection" }, structured: choice, dependencies: {
      descriptionVersionId, sourceHash, sourceIds: [], originBaselineId: id() }, reset: false });
  const first = cvProjectRefinements({ content, targets, library, refinements: [row],
    descriptionVersionId, sourceHash });
  expect(first.conflicts).toEqual([]);
  expect(first.content.sections.at(-1)?.skillItems).toEqual(["Excel"]);
  expect(first.targets.sections.at(-1)).toMatchObject({ entryId, sectionId,
    bulletIds: [bulletId], skillIds: [itemId] });
  expect(cvProjectSkillSelection(content, targets, choice).targets).toEqual(first.targets);
  const writing = cvRefineWritingLibrary(library, [row]);
  expect(cvTailoringEvidence(writing).some(item => item.text === "Excel" && item.entryId === entryId)).toBe(false);
  const dependency = cvRefinementDependencies({ content: first.content, targets: first.targets,
    library: writing, descriptionVersionId, target: { type: "skill", id: itemId } });
  const exact = CvRefinementSchema.parse({ id: id(), version: 1, order: 1,
    kind: "exact_wording", target: { type: "skill", id: itemId }, text: "Excel reporting",
    dependencies: { ...dependency, descriptionVersionId, originBaselineId: row.dependencies.originBaselineId }, reset: false });
  const afterStructure = cvApplyGeneratedStructure({ candidate: content, source: content,
    sourceTargets: targets, refinements: [row, exact] });
  expect(afterStructure.conflicts).toEqual([]);
  const afterExact = cvApplyGeneratedExactLocks({ candidate: afterStructure.content, source: content,
    sourceTargets: targets, library, refinements: [row, exact], descriptionVersionId });
  expect(afterExact.conflicts).toEqual([]);
  expect(afterExact.content.sections.at(-1)?.skillItems).toEqual(["Excel reporting"]);
  expect(cvProjectRefinements({ content, targets, library, refinements: [{ ...row, version: 2, reset: true }],
    descriptionVersionId, sourceHash }).content).toEqual(content);
});
