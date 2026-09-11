import { expect, it } from "vitest";
import { roleStatus } from "./role-workflow";
it("keeps user choices independent of matching and puts archive first", () => {
  for (const inTable of [true, false]) {
    expect(roleStatus({ inTable }, { decision: "apply" })).toBe("user-shortlisted");
    expect(roleStatus({ inTable }, { decision: "skip" })).toBe("user-dismissed");
    expect(roleStatus({ inTable, archivedAt: new Date() }, { decision: "apply" })).toBe("archived");
  }
  expect(roleStatus({ inTable: true })).toBe("auto-matched");
  expect(roleStatus({ inTable: false })).toBe("archived");
});
