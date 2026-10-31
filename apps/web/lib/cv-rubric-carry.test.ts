import { describe, expect, it } from "vitest";
import { rubricFixture } from "../../../packages/core/test/cv-review-fixture";
import { cvRevisionRubricCheckpoint } from "./cv-rubric-carry";

describe("revision rubric carry", () => {
  const role = "Lead a team";
  const assessed = rubricFixture(role);
  const checkpoint = { ...assessed, caveats: ["Checkpoint"] };

  it("prefers a valid assessment, then a valid checkpoint", () => {
    expect(cvRevisionRubricCheckpoint({ jobDescription: role, assessment: { rubric: assessed },
      buildCheckpoint: { sourceRubric: checkpoint } }, role)).toEqual({ sourceRubric: assessed });
    expect(cvRevisionRubricCheckpoint({ jobDescription: role, assessment: null,
      buildCheckpoint: { sourceRubric: checkpoint } }, role)).toEqual({ sourceRubric: checkpoint });
    expect(cvRevisionRubricCheckpoint({ jobDescription: role, assessment: { rubric: rubricFixture("Other role") },
      buildCheckpoint: { sourceRubric: checkpoint } }, role)).toEqual({ sourceRubric: checkpoint });
  });

  it("does not carry an old or malformed role rubric", () => {
    expect(cvRevisionRubricCheckpoint({ jobDescription: role, assessment: { rubric: assessed } }, "Other role")).toBeNull();
    expect(cvRevisionRubricCheckpoint({ jobDescription: role,
      buildCheckpoint: { sourceRubric: rubricFixture("Other role") } }, role)).toBeNull();
    expect(cvRevisionRubricCheckpoint({ jobDescription: role,
      buildCheckpoint: { sourceRubric: { requirements: "invalid" } } }, role)).toBeNull();
  });

  it("carries the immutable role rubric instead of a ranked member-edited assessment", () => {
    const edited = { ...assessed, requirements: assessed.requirements.map((item, index) =>
      index === 0 ? { ...item, label: "My revised requirement", origin: "role" as const, customised: true, rank: 1 } : item) };
    const source = { jobDescription: role, assessment: { rubric: edited }, targetingBrief: { priority: {
      rubric: assessed, requirements: [{ id: assessed.requirements[0]!.id, text: "My revised requirement", essential: true }],
    } } };
    expect(cvRevisionRubricCheckpoint(source, role)).toEqual({ sourceRubric: assessed });
    expect(cvRevisionRubricCheckpoint({ ...source, targetingBrief: { priority: { requirements: source.targetingBrief.priority.requirements } } }, role))
      .toBeNull();
  });
});
