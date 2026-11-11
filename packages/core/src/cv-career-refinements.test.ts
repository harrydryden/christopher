import { describe, expect, it } from "vitest";
import { CvContentSchema, CvLibrarySchema } from "./cv";
import { cvCarryEditingTargets, cvEditingTargetsFor, cvRefinementDependencies } from "./cv-editing-modes";

const roleVersion = "00000000-0000-4000-8000-000000000001";
let nextId = 100;
const id = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;
function fixture(rows: Array<{ id: string; text: string; revision?: number }>, selected: number[]) {
  const library = CvLibrarySchema.parse({ name: "Candidate", contact: "London", profile: "",
    entries: [{ id: "role", kind: "experience", heading: "Operations lead", details: rows.map(row => row.text).join("\n"),
      confirmedResponsibilities: rows.map(row => row.text) }],
    careerProjection: { version: 1, presentation: "chronological", display: {},
      sourceMap: Object.fromEntries(rows.map((row, index) => [`entry:role:row:${index}`, {
        recordId: "role", recordRevision: 1, assertionId: row.id, assertionRevision: row.revision ?? 1, publicText: false,
      }])) } });
  const content = CvContentSchema.parse({ name: "Candidate", contact: "London", summary: "Operations lead",
    sections: [{ entryId: "role", kind: "experience", heading: "Operations lead",
      bullets: selected.map(index => rows[index]!.text), bulletSources: selected.map(index => [`entry:role:row:${index}`]) }], gaps: [] });
  return { library, content, targets: cvEditingTargetsFor(content, id) };
}
function dependency(value: ReturnType<typeof fixture>, bullet: number) {
  return cvRefinementDependencies({ ...value, descriptionVersionId: roleVersion,
    target: { type: "bullet", id: value.targets.sections[0]!.bulletIds[bullet]! } });
}

describe("career identities across CV source selection", () => {
  it("keeps a cited fact's dependency when another row moves ahead of it", () => {
    const before = fixture([{ id: "fact-b", text: "Coached six colleagues" }], [0]);
    const after = fixture([{ id: "fact-a", text: "Introduced weekly reviews" }, { id: "fact-b", text: "Coached six colleagues" }], [1]);
    expect(dependency(after, 0).sourceHash).toBe(dependency(before, 0).sourceHash);
    const changed = fixture([{ id: "fact-a", text: "Introduced weekly reviews" }, { id: "fact-b", text: "Coached eight colleagues", revision: 2 }], [1]);
    expect(dependency(changed, 0).sourceHash).not.toBe(dependency(before, 0).sourceHash);
  });

  it("carries the same bullet target despite another new cited bullet in its section", () => {
    const before = fixture([{ id: "fact-b", text: "Coached six colleagues" }], [0]);
    const after = fixture([{ id: "fact-a", text: "Introduced weekly reviews" }, { id: "fact-b", text: "Coached six colleagues" }], [0, 1]);
    const carried = cvCarryEditingTargets({ priorContent: before.content, priorTargets: before.targets,
      priorLibrary: before.library, priorDescriptionVersionId: roleVersion, content: after.content,
      library: after.library, descriptionVersionId: roleVersion, createId: id });
    expect(carried.sections[0]!.bulletIds[1]).toBe(before.targets.sections[0]!.bulletIds[0]);
    expect(carried.sections[0]!.bulletIds[0]).not.toBe(before.targets.sections[0]!.bulletIds[0]);
  });

  it("does not transfer identity between different assertions that happen to have identical wording", () => {
    const before = fixture([{ id: "fact-b", text: "Supported delivery" }], [0]);
    const after = fixture([{ id: "fact-c", text: "Supported delivery" }], [0]);
    expect(dependency(after, 0).sourceHash).not.toBe(dependency(before, 0).sourceHash);
    const carried = cvCarryEditingTargets({ priorContent: before.content, priorTargets: before.targets,
      priorLibrary: before.library, priorDescriptionVersionId: roleVersion, content: after.content,
      library: after.library, descriptionVersionId: roleVersion, createId: id });
    expect(carried.sections[0]!.bulletIds[0]).not.toBe(before.targets.sections[0]!.bulletIds[0]);
  });
});
