import { describe, expect, it } from "vitest";
import { ROLE_TABS } from "@christopher/core";
import { sortRoleRows, parseRolesFilters, applyRolesFilters, filtersToQueryString, roleTabFor, type RoleRow } from "./jobs";
const row = (score: number | null) => ({ job: { fitScore: score, status: "open", postedAt: null, firstSeenAt: new Date(), closedAt: null } }) as RoleRow;
describe("fit ordering", () => {
  it("keeps unscored roles last in both directions", () => {
    const rows = [row(null), row(20), row(90)];
    expect(sortRoleRows(rows, "fit", "desc").map(r => r.job.fitScore)).toEqual([90, 20, null]);
    expect(sortRoleRows(rows, "fit", "asc").map(r => r.job.fitScore)).toEqual([20, 90, null]);
    expect(sortRoleRows(rows, "status", "asc").map(r => r.job.fitScore)).toEqual([90, 20, null]);
  });
});

describe("inbox decisions", () => {
  it("shows only unreviewed roles by default and restores reset decisions", () => {
    const skipped = { ...row(20), decision: { decision: "skip" } } as RoleRow;
    const applied = { ...row(20), decision: { decision: "apply" } } as RoleRow;
    const undecided = { ...row(20), decision: null } as RoleRow;
    const rows = [skipped, applied, undecided];
    expect(applyRolesFilters(rows, parseRolesFilters({}))).toEqual([undecided]);
    expect(applyRolesFilters(rows, parseRolesFilters({ decision: "skip" }))).toEqual([skipped]);
    expect(applyRolesFilters(rows, parseRolesFilters({ decision: "all" }))).toHaveLength(3);
    expect(applyRolesFilters([{ ...skipped, decision: null }], parseRolesFilters({}))).toHaveLength(1);
    expect(filtersToQueryString(parseRolesFilters({ decision: "all" }))).toContain("decision=all");
  });
});

describe("role tabs", () => {
  it("answers with one of the three tabs, whatever the link says", () => {
    for (const tab of ROLE_TABS) expect(roleTabFor({ view: tab })).toBe(tab);
    expect(roleTabFor({})).toBe("auto-matched");
    expect(roleTabFor({ view: "nonsense" })).toBe("auto-matched");
  });

  it("sends a legacy archived link to Dismissed, where the archived roles now are", () => {
    expect(roleTabFor({ view: "archived" })).toBe("user-dismissed");
    expect(roleTabFor({ archive: "1" })).toBe("user-dismissed");
    expect(roleTabFor({ decision: "skip" })).toBe("user-dismissed");
    expect(roleTabFor({ decision: "apply" })).toBe("user-shortlisted");
    expect(roleTabFor({ view: ["archived"] })).toBe("user-dismissed");
  });

  it("keeps the filters each of the two tables reads", () => {
    // The main table under Dismissed, and the archived section below it.
    expect(parseRolesFilters({ view: "user-dismissed" }).decision).toBe("skip");
    expect(parseRolesFilters({ view: "archived" }).decision).toBe("all");
  });
});
