import { expect, it } from "vitest";
import { CvLibrarySchema } from "./cv";
import { cvSkillCharacterState } from "./cv-format";

it("keeps the editor warning and validity aligned with stored skill labels", () => {
  for (const length of [119, 120, 149, 150, 151]) {
    const label = `  ${"x".repeat(length)}  `;
    const state = cvSkillCharacterState(label);
    const parsed = CvLibrarySchema.safeParse({ name: "Example", contact: "", profile: "", entries: [
      { id: "skills", kind: "skill", heading: "Skills", details: "Supporting evidence", skillItems: [label] },
    ] });
    expect(state).toEqual({ count: length, approaching: length >= 120 && length <= 150, tooLong: length > 150 });
    expect(parsed.success).toBe(!state.tooLong);
  }
});
