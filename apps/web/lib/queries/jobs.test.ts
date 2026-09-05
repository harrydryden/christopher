import { describe, expect, it } from "vitest";
import { sortRoleRows, type RoleRow } from "./jobs";
const row = (score: number | null) => ({ job: { fitScore: score, status: "open", postedAt: null, firstSeenAt: new Date(), closedAt: null } }) as RoleRow;
describe("fit ordering", () => {
  it("keeps unscored roles last in both directions", () => {
    const rows = [row(null), row(20), row(90)];
    expect(sortRoleRows(rows, "fit", "desc").map(r => r.job.fitScore)).toEqual([90, 20, null]);
    expect(sortRoleRows(rows, "fit", "asc").map(r => r.job.fitScore)).toEqual([20, 90, null]);
    expect(sortRoleRows(rows, "status", "asc").map(r => r.job.fitScore)).toEqual([90, 20, null]);
  });
});
