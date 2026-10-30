import { expect, it } from "vitest";
import type { CvTargetingChoices, CvTargetingView } from "@col/core/cv-targeting";
import { affectedCvTargetingEssentials, cvTargetingEvidenceEntryIds, cvTargetingHasProfileEvidence } from "./cv-targeting-choices";

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
