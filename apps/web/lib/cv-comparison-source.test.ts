import { expect, it, vi } from "vitest";
import { CvContentSchema } from "@col/core/cv";
import { cvEditingTargetsFor } from "@col/core/cv-editing-modes";
import type { cvDrafts } from "@col/db";

const mocks = vi.hoisted(() => ({ parent: null as unknown, targeting: vi.fn(), baselineView: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: () => ({ select: () => ({ from: () => ({ where: () => ({
  limit: async () => mocks.parent ? [mocks.parent] : [],
}) }) }) }) }));
vi.mock("@/lib/cv-targeting-view", () => ({ cvTargetingViewForOwnedDraft: mocks.targeting }));
vi.mock("@/lib/cv-baseline-targeting-view", () => ({ cvBaselineTargetingView: mocks.baselineView }));

import { cvComparisonSourceForOwnedDraft, cvComparisonSourceMatches } from "./cv-comparison-source";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const content = CvContentSchema.parse({ name: "Ada", contact: "London", summary: "Operations leader",
  sections: [{ entryId: "role", kind: "experience", heading: "Director", bullets: ["Improved delivery"] }], gaps: [] });
const targets = cvEditingTargetsFor(content, (() => { let n = 1; return () => id(n++); })());
type Draft = typeof cvDrafts.$inferSelect;
const parent = { id: id(10), userId: id(11), contextId: id(12), descriptionVersionId: id(13),
  editingMode: "manual", content, editingTargets: targets } as unknown as Draft;
const result = { id: id(14), userId: parent.userId, contextId: parent.contextId,
  descriptionVersionId: parent.descriptionVersionId, editingMode: "refine", refinementOriginKind: "manual",
  parentId: parent.id, refinementSourceContent: content, refinementSourceTargets: targets,
  content: { ...content, summary: "New wording" } } as unknown as Draft;

it("uses the retained Manual parent rather than the selected Refine result for historical priorities", async () => {
  mocks.parent = parent;
  mocks.targeting.mockReset().mockImplementation(async (_userId: string, draft: Draft) => ({
    draftId: draft.id, priorities: [{ id: "source-priority", text: "Original role priority" }],
    entries: [{ entryId: "role", treatment: "feature" }],
  }));
  const comparison = await cvComparisonSourceForOwnedDraft(parent.userId, parent.contextId!, result);
  expect(comparison).toMatchObject({ provenance: "exact", sourceTargeting: { draftId: parent.id,
    priorities: [{ text: "Original role priority" }] } });
  expect(mocks.targeting).toHaveBeenCalledWith(parent.userId, parent);
  expect(mocks.targeting).not.toHaveBeenCalledWith(parent.userId, result);
});

it("fails closed for a changed retained source, target IDs or role version", async () => {
  expect(cvComparisonSourceMatches(result, parent)).toBe(true);
  expect(cvComparisonSourceMatches(result, { ...parent, content: { ...content, summary: "Changed source" } })).toBe(false);
  expect(cvComparisonSourceMatches(result, { ...parent, editingTargets: { ...targets, summaryId: id(99) } })).toBe(false);
  expect(cvComparisonSourceMatches(result, { ...parent, descriptionVersionId: id(99) })).toBe(false);
  expect(cvComparisonSourceMatches(result, { ...parent,
    content: { ...content, historicalMeaning: "Unrecognised saved field" } })).toBe(false);
  mocks.parent = { ...parent, content: { ...content, summary: "Changed source" } };
  mocks.targeting.mockClear();
  expect(await cvComparisonSourceForOwnedDraft(parent.userId, parent.contextId!, result))
    .toEqual({ provenance: "unavailable", sourceTargeting: null });
  expect(mocks.targeting).not.toHaveBeenCalled();
});

it("uses the retained Auto baseline ID and its own priority view after producer draft pruning", async () => {
  const baseline = { id: id(20), userId: parent.userId, contextId: parent.contextId,
    descriptionVersionId: parent.descriptionVersionId, status: "ready", content,
    editingTargets: targets, librarySnapshot: { name: "Ada", profile: "Operations leader", entries: [] },
    assessment: { rubric: { requirements: [] } }, tailoringPlan: null, inputSnapshot: { description: "Role" } };
  const autoResult = { ...result, refinementOriginKind: "baseline", autoBaselineId: baseline.id,
    parentId: null } as unknown as Draft;
  mocks.parent = baseline;
  mocks.baselineView.mockReset().mockReturnValue({ draftId: baseline.id,
    priorities: [{ text: "Auto role priority" }] });
  const comparison = await cvComparisonSourceForOwnedDraft(parent.userId, parent.contextId!, autoResult);
  expect(comparison).toMatchObject({ provenance: "exact", sourceTargeting: { draftId: baseline.id,
    priorities: [{ text: "Auto role priority" }] } });
  expect(mocks.baselineView).toHaveBeenCalledWith(expect.objectContaining({ id: baseline.id }));
});

it("compares a chained exact result with its verified immediate Refine parent", async () => {
  const generated = { ...parent, editingMode: "refine", content: { ...content,
    summary: "Instruction-generated summary" } } as unknown as Draft;
  const exactChild = { ...result, refinementOriginKind: "baseline", autoBaselineId: id(20),
    parentId: generated.id, refinementSourceContent: generated.content } as unknown as Draft;
  mocks.parent = generated;
  mocks.targeting.mockReset().mockResolvedValue({ draftId: generated.id,
    priorities: [{ text: "Parent role priority" }] });
  mocks.baselineView.mockClear();
  expect(await cvComparisonSourceForOwnedDraft(parent.userId, parent.contextId!, exactChild))
    .toMatchObject({ provenance: "exact", sourceTargeting: { draftId: generated.id,
      priorities: [{ text: "Parent role priority" }] } });
  expect(mocks.baselineView).not.toHaveBeenCalled();
});
