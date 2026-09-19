import { expect, it } from "vitest";
import { ROLE_STATUSES, ROLE_STATUS_LABELS, ROLE_TABS, roleStatus } from "./role-workflow";
it("keeps user choices independent of matching and puts archive first", () => {
  for (const inTable of [true, false]) {
    expect(roleStatus({ inTable }, { decision: "apply" })).toBe("user-shortlisted");
    expect(roleStatus({ inTable }, { decision: "skip" })).toBe("user-dismissed");
    expect(roleStatus({ inTable, archivedAt: new Date() }, { decision: "apply" })).toBe("archived");
  }
  expect(roleStatus({ inTable: true })).toBe("auto-matched");
  expect(roleStatus({ inTable: false })).toBe("archived");
});

it("names the statuses for a person and leaves archive out of the tab strip", () => {
  // The keys are URL values and SQL; only the labels and their order are the interface's.
  expect(ROLE_STATUSES).toEqual(["user-shortlisted", "auto-matched", "user-dismissed", "archived"]);
  expect(ROLE_STATUSES.map((status) => ROLE_STATUS_LABELS[status])).toEqual(["Shortlisted", "Matched", "Dismissed", "Archived"]);
  expect(ROLE_TABS).toEqual(["user-shortlisted", "auto-matched", "user-dismissed"]);
  expect(ROLE_TABS).not.toContain("archived");
});
