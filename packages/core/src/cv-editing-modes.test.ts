import { describe, expect, it } from "vitest";
import { CvContentSchema, CvLibrarySchema } from "./cv";
import { cvApplyExactLocks, cvApplyGeneratedExactLocks, cvAutoInputKey, cvCarryEditingTargets, cvEditingTargetsFor,
  cvProjectRefinements, cvProjectOneExactWording, cvRefinementDependencies, cvRefinedResultKey,
  validateCvEditingTargets, validateCvEditingTargetTransition, CvRefinementSchema, type CvAutoInputV1 } from "./cv-editing-modes";

const library = CvLibrarySchema.parse({ name: "Ada", contact: "London", profile: "Supported operations delivery",
  entries: [{ id: "role", kind: "experience", heading: "Operations Manager", details: "Reduced backlog by 20%",
    confirmedResponsibilities: ["Reduced backlog by 20%"] }] });
const content = CvContentSchema.parse({ name: "Ada", contact: "London", summary: "Operations manager",
  sections: [{ entryId: "role", kind: "experience", heading: "Operations Manager",
    bullets: ["Reduced backlog by 20%", "Reduced backlog by 20%"], bulletSources: [["entry:role:row:0"], ["entry:role:row:0"]] }], gaps: [] });
const input: CvAutoInputV1 = { version: 1, contextId: "00000000-0000-4000-8000-000000000001",
  descriptionVersionId: "00000000-0000-4000-8000-000000000002", jobTitle: "Head of Operations", companyName: "Acme",
  description: "Improve operations delivery", library, basePriorityIdentity: "source-default",
  appearance: undefined, writingPreferences: {}, routes: { author: { model: "model-a", effort: "high" } },
  contracts: { promptSet: "p1", review: "r1", fit: "f1", render: "v1" } };

describe("CV editing identities", () => {
  it("projects one stable exact edit without reverting generated wording or other citations and signposts", () => {
    let n = 100;
    const generated = CvContentSchema.parse({ ...content, summary: "Generated instruction wording",
      sections: [{ ...content.sections[0]!, bullets: ["Generated first result", "Generated second result"],
        bulletSignposts: ["Impact", "Delivery"] }] });
    const targets = cvEditingTargetsFor(generated, () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`);
    const updated = cvProjectOneExactWording({ content: generated, targets,
      target: { type: "bullet", id: targets.sections[0]!.bulletIds[1]! }, text: "My exact second result" });
    expect(updated.summary).toBe("Generated instruction wording");
    expect(updated.sections[0]!.bullets).toEqual(["Generated first result", "My exact second result"]);
    expect(updated.sections[0]!.bulletSources).toEqual(generated.sections[0]!.bulletSources);
    expect(updated.sections[0]!.bulletSignposts).toEqual(["Impact", "Delivery"]);
    expect(generated.sections[0]!.bullets[1]).toBe("Generated second result");
    expect(cvProjectOneExactWording({ content: generated, targets,
      target: { type: "section", id: targets.sections[0]!.sectionId }, text: "My own role heading" })
      .sections[0]!.heading).toBe("My own role heading");
    expect(cvProjectOneExactWording({ content: generated, targets,
      target: { type: "summary", id: targets.summaryId }, text: "My exact summary" }).summarySources)
      .toEqual([]);
    expect(() => cvProjectOneExactWording({ content: generated, targets,
      target: { type: "bullet", id: "00000000-0000-4000-8000-000000000999" }, text: "Wrong item" }))
      .toThrow("item changed");
  });

  it("adds, changes, clears and preserves a bullet title without moving its citation", () => {
    let n = 300;
    const targets = cvEditingTargetsFor(content, () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`);
    const target = { type: "bullet" as const, id: targets.sections[0]!.bulletIds[1]! };
    const first = cvProjectOneExactWording({ content, targets, target, text: content.sections[0]!.bullets[1]!,
      bulletSignpost: "  Service delivery  " });
    expect(first.sections[0]!.bulletSignposts).toEqual([null, "Service delivery"]);
    expect(first.sections[0]!.bulletSources).toEqual(content.sections[0]!.bulletSources);
    const titleLock = CvRefinementSchema.parse({ id: "00000000-0000-4000-8000-000000000399",
      version: 1, order: 0, kind: "exact_wording", target, text: content.sections[0]!.bullets[1],
      bulletSignpost: "Service delivery", dependencies: { descriptionVersionId: input.descriptionVersionId,
        sourceHash: "a".repeat(64), sourceIds: ["entry:role:row:0"] }, reset: false });
    const locked = cvApplyExactLocks({ content, targets, refinements: [titleLock],
      descriptionVersionId: input.descriptionVersionId, sourceHash: "a".repeat(64) });
    expect(locked.conflicts).toEqual([]);
    expect(locked.content.sections[0]!.bulletSources).toEqual(content.sections[0]!.bulletSources);
    expect(locked.content.sections[0]!.bulletSignposts).toEqual([null, "Service delivery"]);
    const bodyOnly = cvProjectOneExactWording({ content: first, targets, target, text: "Improved service delivery" });
    expect(bodyOnly.sections[0]!.bulletSignposts).toEqual([null, "Service delivery"]);
    const renamed = cvProjectOneExactWording({ content: bodyOnly, targets, target,
      text: "Improved service delivery", bulletSignpost: "Operational impact" });
    expect(renamed.sections[0]!.bulletSignposts).toEqual([null, "Operational impact"]);
    const cleared = cvProjectOneExactWording({ content: renamed, targets, target,
      text: "Improved service delivery", bulletSignpost: null });
    expect(cleared.sections[0]!.bulletSignposts).toEqual([null, null]);
    expect(() => cvProjectOneExactWording({ content, targets, target, text: "A", bulletSignpost: "x\ny" })).toThrow();
  });

  it("validates that only an exact bullet rule can carry a single-line title", () => {
    const base = { id: "00000000-0000-4000-8000-000000000400", version: 1, order: 0,
      kind: "exact_wording" as const, target: { type: "bullet" as const, id: "00000000-0000-4000-8000-000000000401" },
      text: "Exact claim", dependencies: { descriptionVersionId: input.descriptionVersionId,
        sourceHash: "a".repeat(64), sourceIds: [] }, reset: false };
    expect(CvRefinementSchema.parse({ ...base, bulletSignpost: "  Results  " }).bulletSignpost).toBe("Results");
    expect(CvRefinementSchema.parse(base).bulletSignpost).toBeUndefined();
    for (const row of [
      { ...base, target: { type: "section", id: base.target.id }, bulletSignpost: "Results" },
      { ...base, kind: "instruction", bulletSignpost: "Results" },
      { ...base, bulletSignpost: "bad\nline" },
      { ...base, bulletSignpost: "x".repeat(61) },
      { ...base, bulletSignpost: " " },
    ]) expect(CvRefinementSchema.safeParse(row).success).toBe(false);
  });
  it("ignores object-key order but invalidates Auto on source, role, preference and contract changes", () => {
    const key = cvAutoInputKey(input);
    const reloaded = JSON.parse(JSON.stringify(input));
    reloaded.library = { entries: reloaded.library.entries, profile: reloaded.library.profile,
      contact: reloaded.library.contact, name: reloaded.library.name };
    expect(cvAutoInputKey(reloaded)).toBe(key);
    expect(cvAutoInputKey({ ...input, library: { ...library, profile: "Different confirmed profile" } })).not.toBe(key);
    expect(cvAutoInputKey({ ...input, description: "A changed advert" })).not.toBe(key);
    expect(cvAutoInputKey({ ...input, writingPreferences: { stylePreferences: "Concise" } })).not.toBe(key);
    expect(cvAutoInputKey({ ...input, contracts: { ...input.contracts, render: "v2" } })).not.toBe(key);
    expect(cvAutoInputKey({ ...input, routes: { author: { model: "model-b", effort: "high" } } })).not.toBe(key);
  });

  it("keeps duplicate wording targets separate and validates explicit reordered IDs", () => {
    let n = 0;
    const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    const targets = cvEditingTargetsFor(content, id);
    expect(targets.sections[0]!.bulletIds[0]).not.toBe(targets.sections[0]!.bulletIds[1]);
    const reordered = { ...targets, sections: [{ ...targets.sections[0]!, bulletIds: [...targets.sections[0]!.bulletIds].reverse() }] };
    expect(validateCvEditingTargets(content, reordered)).toEqual(reordered);
    expect(validateCvEditingTargetTransition(content, targets, content, reordered)).toEqual(reordered);
    const added = { ...content, sections: [{ ...content.sections[0]!, bullets: [...content.sections[0]!.bullets, "A new distinct result"] }] };
    const withAdded = { ...targets, sections: [{ ...targets.sections[0]!, bulletIds: [...targets.sections[0]!.bulletIds, id()] }] };
    expect(validateCvEditingTargetTransition(content, targets, added, withAdded)).toEqual(withAdded);
    const removed = { ...content, sections: [{ ...content.sections[0]!, bullets: [content.sections[0]!.bullets[0]!] }] };
    const withRemoved = { ...targets, sections: [{ ...targets.sections[0]!, bulletIds: [targets.sections[0]!.bulletIds[0]!] }] };
    expect(validateCvEditingTargetTransition(content, targets, removed, withRemoved)).toEqual(withRemoved);
    expect(() => validateCvEditingTargets(content, { ...targets, sections: [{ ...targets.sections[0]!, bulletIds: [targets.sections[0]!.bulletIds[0]] }] })).toThrow("out of date");
    expect(() => validateCvEditingTargets(content, { ...targets, sections: [{ ...targets.sections[0]!, bulletIds: [targets.summaryId, targets.sections[0]!.bulletIds[1]] }] })).toThrow("unique");
    const second = { ...content, sections: [{ ...content.sections[0]!, bullets: [content.sections[0]!.bullets[0]!] },
      { ...content.sections[0]!, entryId: "other", bullets: ["Other result"] }] };
    const stolen = { ...targets, sections: [{ ...targets.sections[0]!, bulletIds: [targets.sections[0]!.bulletIds[0]!] },
      { entryId: "other", sectionId: id(), bulletIds: [targets.sections[0]!.bulletIds[1]!], skillIds: [] }] };
    expect(() => validateCvEditingTargetTransition(content, targets, second, stolen)).toThrow("another section");
  });

  it("keys a refined result by active ordered versioned choices, independently of Auto", () => {
    const baseline = "00000000-0000-4000-8000-000000000003";
    const first = cvRefinedResultKey(baseline, [], input.contracts);
    const instruction = { id: "00000000-0000-4000-8000-000000000004", version: 1, order: 0,
      kind: "instruction" as const, target: { type: "summary" as const, id: "00000000-0000-4000-8000-000000000005" },
      text: "Emphasise supported delivery", dependencies: { descriptionVersionId: input.descriptionVersionId,
        sourceHash: "a".repeat(64), sourceIds: ["entry:role:row:0"] }, reset: false };
    expect(cvRefinedResultKey(baseline, [instruction], input.contracts)).not.toBe(first);
    expect(cvRefinedResultKey(baseline, [{ ...instruction, version: 2 }], input.contracts))
      .not.toBe(cvRefinedResultKey(baseline, [instruction], input.contracts));
    expect(cvRefinedResultKey(baseline, [{ ...instruction, reset: true }], input.contracts)).toBe(first);
    expect(cvAutoInputKey(input)).toBe(cvAutoInputKey(input));
  });

  it("keeps an exact lock on its own duplicate-text item and refuses changed source or missing target", () => {
    let n = 10;
    const targets = cvEditingTargetsFor(content, () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`);
    const lock = { id: "00000000-0000-4000-8000-000000000050", version: 1, order: 0,
      kind: "exact_wording" as const, target: { type: "bullet" as const, id: targets.sections[0]!.bulletIds[1] },
      text: "Kept this exact supported wording", dependencies: { descriptionVersionId: input.descriptionVersionId,
        sourceHash: "a".repeat(64), sourceIds: ["entry:role:row:0"] }, reset: false };
    const changed = cvApplyExactLocks({ content, targets, refinements: [lock],
      descriptionVersionId: input.descriptionVersionId, sourceHash: "a".repeat(64) });
    expect(changed.conflicts).toEqual([]);
    expect(changed.content.sections[0]!.bullets).toEqual(["Reduced backlog by 20%", lock.text]);
    expect(changed.content.sections[0]!.bulletSources).toBeUndefined();
    expect(cvApplyExactLocks({ content, targets, refinements: [lock],
      descriptionVersionId: input.descriptionVersionId, sourceHash: "b".repeat(64) })).toMatchObject({
      content, conflicts: [{ id: lock.id, reason: "changed_source" }],
    });
    expect(cvApplyExactLocks({ content, targets: { ...targets, sections: [{ ...targets.sections[0]!,
      bulletIds: [targets.sections[0]!.bulletIds[0]!, "00000000-0000-4000-8000-000000000099"] }] }, refinements: [lock],
      descriptionVersionId: input.descriptionVersionId, sourceHash: "a".repeat(64) }).conflicts[0]?.reason)
      .toBe("missing_target");
  });

  it("keeps unrelated confirmed evidence out of an exact target dependency", () => {
    let n = 60;
    const targets = cvEditingTargetsFor(content, () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`);
    const target = { type: "bullet" as const, id: targets.sections[0]!.bulletIds[0] };
    const dependency = cvRefinementDependencies({ content, targets, library,
      descriptionVersionId: input.descriptionVersionId, target });
    expect(dependency.sourceIds).toEqual(["entry:role:row:0"]);
    const unrelated = CvLibrarySchema.parse({ ...library, entries: [...library.entries,
      { id: "other", kind: "experience", heading: "Other work", details: "A distinct confirmed result",
        confirmedResponsibilities: ["A distinct confirmed result"] }] });
    expect(cvRefinementDependencies({ content, targets, library: unrelated,
      descriptionVersionId: input.descriptionVersionId, target }).sourceHash).toBe(dependency.sourceHash);
    const changed = CvLibrarySchema.parse({ ...library, entries: [{ ...library.entries[0]!,
      details: "Changed result", confirmedResponsibilities: ["Changed result"] }] });
    expect(cvRefinementDependencies({ content, targets, library: changed,
      descriptionVersionId: input.descriptionVersionId, target }).sourceHash).not.toBe(dependency.sourceHash);
  });

  it("projects a free Auto refinement and refuses an ambiguous generated bullet lock", () => {
    let n = 90;
    const targets = cvEditingTargetsFor(content, () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`);
    const dependencies = cvRefinementDependencies({ content, targets, library,
      descriptionVersionId: input.descriptionVersionId,
      target: { type: "bullet", id: targets.sections[0]!.bulletIds[0] } });
    const lock = { id: "00000000-0000-4000-8000-000000000150", version: 1, order: 0,
      kind: "exact_wording" as const, target: { type: "bullet" as const, id: targets.sections[0]!.bulletIds[0] },
      text: "A selected exact result", bulletSignpost: "Result", dependencies: { descriptionVersionId: input.descriptionVersionId, ...dependencies }, reset: false };
    const free = cvProjectRefinements({ content, targets, library, refinements: [lock],
      descriptionVersionId: input.descriptionVersionId, sourceHash: "a".repeat(64) });
    expect(free.conflicts).toEqual([]);
    expect(free.content.sections[0]!.bullets).toEqual([lock.text, "Reduced backlog by 20%"]);
    expect(free.content.sections[0]!.bulletSignposts).toEqual(["Result", null]);
    const generated = CvContentSchema.parse({ ...content, sections: [{ ...content.sections[0]!,
      bullets: ["Reduced backlog by 20%"], bulletSources: [["entry:role:row:0"]] }] });
    const applied = cvApplyGeneratedExactLocks({ candidate: generated, source: content,
      sourceTargets: targets, library, refinements: [lock], descriptionVersionId: input.descriptionVersionId });
    expect(applied.conflicts).toEqual([]);
    expect(applied.content.sections[0]!.bullets).toEqual([lock.text]);
    expect(applied.content.sections[0]!.bulletSignposts).toEqual(["Result"]);
    expect(cvProjectRefinements({ content, targets, library, refinements: [{ ...lock, version: 2, reset: true }],
      descriptionVersionId: input.descriptionVersionId, sourceHash: "a".repeat(64) }).content).toEqual(content);
    const titledGenerated = CvContentSchema.parse({ ...generated, sections: [{ ...generated.sections[0]!,
      bulletSignposts: ["Former title"] }] });
    const cleared = cvApplyGeneratedExactLocks({ candidate: titledGenerated, source: content,
      sourceTargets: targets, library, refinements: [{ ...lock, bulletSignpost: null }],
      descriptionVersionId: input.descriptionVersionId });
    expect(cleared.conflicts).toEqual([]);
    expect(cleared.content.sections[0]!.bulletSignposts).toEqual([null]);
    const ambiguous = cvApplyGeneratedExactLocks({ candidate: content, source: content,
      sourceTargets: targets, library, refinements: [lock], descriptionVersionId: input.descriptionVersionId });
    expect(ambiguous.conflicts[0]?.reason).toBe("missing_target");
    expect(ambiguous.content).toEqual(content);
  });

  it("carries a unique cited target across compatible baselines but not changed or ambiguous evidence", () => {
    let n = 180;
    const createId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    const priorContent = CvContentSchema.parse({ ...content, sections: [{ ...content.sections[0]!,
      bullets: ["Reduced backlog by 20%"], bulletSources: [["entry:role:row:0"]] }] });
    const priorTargets = cvEditingTargetsFor(priorContent, createId);
    const regenerated = CvContentSchema.parse({ ...priorContent, sections: [{ ...priorContent.sections[0]!,
      bullets: ["Cut the backlog by one fifth"] }] });
    const carried = cvCarryEditingTargets({ priorContent, priorTargets, priorLibrary: library,
      priorDescriptionVersionId: input.descriptionVersionId, content: regenerated, library,
      descriptionVersionId: input.descriptionVersionId, createId });
    expect(carried.sections[0]!.sectionId).toBe(priorTargets.sections[0]!.sectionId);
    expect(carried.sections[0]!.bulletIds[0]).toBe(priorTargets.sections[0]!.bulletIds[0]);
    const changed = CvLibrarySchema.parse({ ...library, entries: [{ ...library.entries[0]!,
      details: "Different result", confirmedResponsibilities: ["Different result"] }] });
    const noCarry = cvCarryEditingTargets({ priorContent, priorTargets, priorLibrary: library,
      priorDescriptionVersionId: input.descriptionVersionId, content: regenerated, library: changed,
      descriptionVersionId: input.descriptionVersionId, createId });
    expect(noCarry.sections[0]!.bulletIds[0]).not.toBe(priorTargets.sections[0]!.bulletIds[0]);
    const duplicateTargets = cvEditingTargetsFor(content, createId);
    const ambiguous = cvCarryEditingTargets({ priorContent: content,
      priorTargets: duplicateTargets, priorLibrary: library,
      priorDescriptionVersionId: input.descriptionVersionId, content: regenerated, library,
      descriptionVersionId: input.descriptionVersionId, createId });
    expect(ambiguous.sections[0]!.bulletIds[0]).not.toBe(duplicateTargets.sections[0]!.bulletIds[0]);
    expect(ambiguous.sections[0]!.bulletIds[0]).not.toBe(duplicateTargets.sections[0]!.bulletIds[1]);
  });

  it("applies two generated locks without losing the second target or untouched citations", () => {
    const twoRows = CvLibrarySchema.parse({ ...library, entries: [{ ...library.entries[0]!,
      details: "Reduced backlog by 20%\nCut handoff delay by 10%\nA third supported claim",
      confirmedResponsibilities: ["Reduced backlog by 20%", "Cut handoff delay by 10%", "A third supported claim"] }] });
    const twoBullets = CvContentSchema.parse({ ...content, sections: [{ ...content.sections[0]!,
      bullets: ["Reduced backlog by 20%", "Cut handoff delay by 10%", "A third supported claim"],
      bulletSources: [["entry:role:row:0"], ["entry:role:row:1"], ["entry:role:row:2"]] }] });
    let n = 240;
    const targets = cvEditingTargetsFor(twoBullets, () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`);
    const locks = [0, 1].map((index) => ({ id: `00000000-0000-4000-8000-${String(index + 260).padStart(12, "0")}`,
      version: 1, order: index, kind: "exact_wording" as const,
      target: { type: "bullet" as const, id: targets.sections[0]!.bulletIds[index] },
      text: index ? "Exact handoff result" : "Exact backlog result",
      bulletSignpost: index ? "Handoff" : "Backlog",
      dependencies: { descriptionVersionId: input.descriptionVersionId,
        ...cvRefinementDependencies({ content: twoBullets, targets, library: twoRows,
          descriptionVersionId: input.descriptionVersionId,
          target: { type: "bullet", id: targets.sections[0]!.bulletIds[index] } }) }, reset: false }));
    const generated = CvContentSchema.parse({ ...twoBullets, sections: [{ ...twoBullets.sections[0]!,
      bullets: ["Backlog fell by 20%", "Handoffs sped up by 10%", "A third supported claim"] }] });
    const result = cvApplyGeneratedExactLocks({ candidate: generated, source: twoBullets,
      sourceTargets: targets, library: twoRows, refinements: locks,
      descriptionVersionId: input.descriptionVersionId });
    expect(result.conflicts).toEqual([]);
    expect(result.content.sections[0]!.bullets).toEqual(["Exact backlog result", "Exact handoff result", "A third supported claim"]);
    expect(result.content.sections[0]!.bulletSignposts).toEqual(["Backlog", "Handoff", null]);
    expect(result.content.sections[0]!.bulletSources).toEqual(generated.sections[0]!.bulletSources);
  });
});
