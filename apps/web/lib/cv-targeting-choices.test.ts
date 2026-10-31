import { expect, it } from "vitest";
import type { CvTargetingChoices, CvTargetingView } from "@col/core/cv-targeting";
import { affectedCvTargetingEssentials, cvTargetingChoiceIssue, cvTargetingEvidenceEntryIds, cvTargetingHasProfileEvidence,
  moveCvTargetingRequirement, withCvTargetingRequirements } from "./cv-targeting-choices";

const view = { entries: [{ entryId: "a", treatment: "feature" }, { entryId: "b", treatment: "feature" }],
  priorities: [
    { id: "profile", importance: "essential", evidenceEntryIds: [], hasProfileEvidence: true },
    { id: "mixed", importance: "essential", evidenceEntryIds: ["a"], hasProfileEvidence: true },
    { id: "other", importance: "essential", evidenceEntryIds: ["b"] },
  ] } as CvTargetingView;

it("retains the broad profile dependency and exact entry references from a plan", () => {
  expect(cvTargetingEvidenceEntryIds([{ sourceId: "source:profile" }, { sourceId: "entry:a:row:2" },
    { sourceId: "entry:a:skill:1" }, { sourceId: "entry:b" }]))
    .toEqual(["a", "b"]);
  expect(cvTargetingHasProfileEvidence([{ sourceId: "source:profile" }, { sourceId: "entry:a" }])).toBe(true);
  expect(cvTargetingEvidenceEntryIds([{ sourceId: "entry:source:profile" }])).toEqual(["source:profile"]);
});

it("requires acknowledgement when an omission removes profile-only or sole entry evidence", () => {
  const choices = { entries: [{ entryId: "a", treatment: "omit" }, { entryId: "b", treatment: "feature" }] } as CvTargetingChoices;
  expect(affectedCvTargetingEssentials(view, choices).map(item => item.id)).toEqual(["profile", "mixed"]);
  expect(affectedCvTargetingEssentials(view, { ...choices,
    entries: choices.entries.map(item => ({ ...item, treatment: "feature" })) }).map(item => item.id)).toEqual([]);
});

it("moves one stable requirement to a numeric rank and keeps focus on the first five", () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({ id: `r${index + 1}`, text: `Requirement ${index + 1}`, essential: index === 0 }));
  const moved = moveCvTargetingRequirement(rows, "r6", 2);
  expect(moved.map(row => row.id)).toEqual(["r1", "r6", "r2", "r3", "r4", "r5"]);
  expect(rows.map(row => row.id)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]);
  expect(withCvTargetingRequirements({ entries: [], presentation: { maxPages: 2, bodySizePt: 12 },
    emphasisRequirementIds: [], acknowledgedEssentialOmissionIds: [] }, moved).emphasisRequirementIds)
    .toEqual(["r1", "r6", "r2", "r3", "r4"]);
});

it("accepts one ranked requirement but refuses the last removal, blank text and stale focus", () => {
  const base = { entries: [], presentation: { maxPages: 2 as const, bodySizePt: 12 as const },
    emphasisRequirementIds: [] as string[], acknowledgedEssentialOmissionIds: [] as string[] };
  expect(cvTargetingChoiceIssue(view, { ...base, requirements: [] })).toBe("Keep at least one role requirement.");
  expect(cvTargetingChoiceIssue(view, withCvTargetingRequirements(base, [{ id: "one", text: "Lead operations", essential: true }]))).toBeNull();
  expect(cvTargetingChoiceIssue(view, withCvTargetingRequirements(base, [{ id: "one", text: "  ", essential: true }])))
    .toBe("Write each role requirement in 1–250 characters.");
  expect(cvTargetingChoiceIssue(view, { ...base, requirements: [{ id: "one", text: "Lead operations", essential: true }] }))
    .toBe("Reload the ranked requirements before confirming.");
});

it("does not claim old evidence still supports edited requirement wording", () => {
  const rankedView = { ...view, priorities: [{ ...view.priorities[2]!, id: "other", text: "Lead operations", essential: true }] } as CvTargetingView;
  const base = { entries: [{ entryId: "a", treatment: "feature" }, { entryId: "b", treatment: "omit" }],
    presentation: { maxPages: 2 as const, bodySizePt: 12 as const },
    emphasisRequirementIds: ["other"], acknowledgedEssentialOmissionIds: [] } as CvTargetingChoices;
  expect(affectedCvTargetingEssentials(rankedView, { ...base,
    requirements: [{ id: "other", text: "Lead operations", essential: true }] }).map(item => item.id)).toEqual(["other"]);
  expect(affectedCvTargetingEssentials(rankedView, { ...base,
    requirements: [{ id: "other", text: "Run strategy", essential: true }] })).toEqual([]);
});

it("keeps exact-text evidence guidance when only rank changes", () => {
  const rankedView = { ...view, priorities: [
    { ...view.priorities[2]!, id: "other", text: "Lead operations", essential: true },
    { ...view.priorities[1]!, id: "mixed", text: "Develop strategy", essential: true },
  ] } as CvTargetingView;
  const choices = { entries: [{ entryId: "a", treatment: "feature" }, { entryId: "b", treatment: "omit" }],
    presentation: { maxPages: 2 as const, bodySizePt: 12 as const }, emphasisRequirementIds: ["mixed", "other"],
    requirements: [{ id: "mixed", text: "Develop strategy", essential: true },
      { id: "other", text: "Lead operations", essential: true }], acknowledgedEssentialOmissionIds: [] } as CvTargetingChoices;
  expect(affectedCvTargetingEssentials(rankedView, choices).map(item => item.id)).toEqual(["other"]);
  expect(cvTargetingChoiceIssue(rankedView, { ...choices, acknowledgedEssentialOmissionIds: ["other"] })).toBeNull();
});
