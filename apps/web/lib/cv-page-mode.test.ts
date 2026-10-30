import { expect, it } from "vitest";
import { cvPageMode, type CvPageStatus } from "./cv-page-mode";

it.each([
  ["queued", false, true, false, false],
  ["queued", true, true, false, false],
  ["generating", false, true, false, false],
  ["generating", true, true, false, false],
  ["awaiting_evidence", false, false, true, false],
  ["awaiting_evidence", true, false, true, false],
  ["awaiting_priorities", false, false, true, false],
  ["awaiting_priorities", true, false, true, false],
  ["ready", false, false, false, false],
  ["ready", true, false, false, true],
  ["failed", false, false, false, false],
  ["failed", true, false, false, true],
] as const)("classifies %s with content=%s", (status, hasContent, processing, paused, editable) => {
  expect(cvPageMode(status as CvPageStatus, hasContent)).toEqual({ processing, paused, editable });
});

it("fails closed for a future status", () => {
  expect(cvPageMode("unknown" as CvPageStatus, true).editable).toBe(false);
});
