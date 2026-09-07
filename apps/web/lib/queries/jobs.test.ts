import { describe, expect, it } from "vitest";
import { sortRoleRows, parseRolesFilters, applyRolesFilters, filtersToQueryString, type RoleRow } from "./jobs";
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
  it("hides skipped roles by default, retains apply choices and restores undone skips", () => {
    const skipped = { ...row(20), decision: { decision: "skip" } } as RoleRow;
    const applied = { ...row(20), decision: { decision: "apply" } } as RoleRow;
    const undecided = { ...row(20), decision: null } as RoleRow;
    const rows = [skipped, applied, undecided];
    expect(applyRolesFilters(rows, parseRolesFilters({}))).toEqual([applied, undecided]);
    expect(applyRolesFilters(rows, parseRolesFilters({ decision: "skip" }))).toEqual([skipped]);
    expect(applyRolesFilters(rows, parseRolesFilters({ decision: "all" }))).toHaveLength(3);
    expect(applyRolesFilters([{ ...skipped, decision: null }], parseRolesFilters({}))).toHaveLength(1);
    expect(filtersToQueryString(parseRolesFilters({ decision: "all" }))).toContain("decision=all");
  });
});
