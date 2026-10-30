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
});
