import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { sql } from "drizzle-orm";
import { ROLE_TABS, type RoleStatus } from "@christopher/core";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@christopher/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
vi.mock("@/lib/db", () => ({ db: () => database }));
import { sortRoleRows, parseRolesFilters, applyRolesFilters, buildRoleRowVM, fetchRolePage, filtersToQueryString, resolveRoleView, roleTabFor, type RoleRow } from "./jobs";

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());

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
  it("answers with one of the three tabs, or none when the link names none", () => {
    for (const tab of ROLE_TABS) expect(roleTabFor({ view: tab })).toBe(tab);
    // No view in the link, and an unknown one, both leave the choice to the counts.
    expect(roleTabFor({})).toBeNull();
    expect(roleTabFor({ view: "nonsense" })).toBeNull();
  });

  it("sends a legacy archived link to Dismissed, where the archived roles now are", () => {
    expect(roleTabFor({ view: "archived" })).toBe("user-dismissed");
    expect(roleTabFor({ archive: "1" })).toBe("user-dismissed");
    expect(roleTabFor({ decision: "skip" })).toBe("user-dismissed");
    expect(roleTabFor({ decision: "apply" })).toBe("user-shortlisted");
    expect(roleTabFor({ view: ["archived"] })).toBe("user-dismissed");
  });

  it("opens on Matched, and on Shortlisted when this scope has nothing matched", () => {
    const counts: Record<RoleStatus, number> = { "auto-matched": 3, "user-shortlisted": 2, "user-dismissed": 1, archived: 4 };
    expect(resolveRoleView({}, counts)).toBe("auto-matched");
    expect(resolveRoleView({}, { ...counts, "auto-matched": 0 })).toBe("user-shortlisted");
    // Counts a caller has not taken are zero, never a reason to open on an empty Matched.
    expect(resolveRoleView({}, {})).toBe("user-shortlisted");
    // A link that names a view is answered whatever the counts say.
    expect(resolveRoleView({ view: "user-dismissed" }, counts)).toBe("user-dismissed");
    expect(resolveRoleView({ archive: "1" }, { ...counts, "auto-matched": 0 })).toBe("user-dismissed");
  });

  it("keeps the filters each of the two tables reads", () => {
    // The main table under Dismissed, and the archived section below it.
    expect(parseRolesFilters({ view: "user-dismissed" }).decision).toBe("skip");
    expect(parseRolesFilters({ view: "archived" }).decision).toBe("all");
  });
});

describe("the stage a row carries", () => {
  it("passes the stage and the application's own status into the view model", () => {
    const shortlisted = {
      job: { id: "job-1", title: "Operations Director", url: "https://acme.test/jobs/1", location: "London", locations: ["London"], remote: false, department: null, employmentType: null, salaryText: null, keywordTerms: [], fitScore: null, fitRationale: null, status: "open", postedAt: null, firstSeenAt: new Date("2026-09-01T00:00:00Z"), closedAt: null, seeded: false, origin: "scan", addedBy: null },
      company: { id: "company-1", name: "Acme", faviconUrl: null, logoFetchedAt: null, homepageUrl: "https://acme.test", domain: "acme.test" },
      sourceType: "html",
      decision: null,
      stage: "in_process",
      applicationStatus: "interview",
      events: [],
    } as unknown as RoleRow;
    const vm = buildRoleRowVM(shortlisted, new Date("2026-09-19T00:00:00Z"));
    expect(vm.stage).toBe("in_process");
    expect(vm.applicationStatus).toBe("interview");
    const bare = buildRoleRowVM({ ...shortlisted, stage: "shortlisted", applicationStatus: null }, new Date("2026-09-19T00:00:00Z"));
    expect(bare.stage).toBe("shortlisted");
    expect(bare.applicationStatus).toBeNull();
  });

  /**
   * The page reads the stage at the database, so a role that reached an interview says so on the
   * Shortlisted tab rather than reading as a bare shortlist — and the role beside it, with no
   * application at all, is still on the page: the newest-application join is a LEFT JOIN.
   */
  it("reads a shortlisted role with an interview application as in process", async () => {
    await database.execute(sql`truncate users, companies restart identity cascade`);
    const user: User = await ensureTestUser(database, "role-stage@example.com");
    const [company] = await database.insert(schema.companies).values({ name: "Acme", domain: "acme.test", homepageUrl: "https://acme.test" }).returning();
    const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://acme.test/jobs" }).returning();
    const [interviewing, justShortlisted] = await database.insert(schema.jobs).values([
      { companyId: company!.id, sourceId: source!.id, externalKey: "id:1", title: "Operations Director", normalizedTitle: "operations director", url: "https://acme.test/jobs/1", location: "London", locations: ["London"] },
      { companyId: company!.id, sourceId: source!.id, externalKey: "id:2", title: "Head of Delivery", normalizedTitle: "head of delivery", url: "https://acme.test/jobs/2", location: "London", locations: ["London"] },
    ]).returning();
    for (const job of [interviewing!, justShortlisted!]) {
      await database.insert(schema.userJobs).values({ userId: user.id, jobId: job.id, keywordMatched: true, locationOk: true, inTable: true });
      await database.insert(schema.decisions).values({ userId: user.id, jobId: job.id, decision: "apply", jobTitle: job.title, companyName: company!.name });
    }
    await database.insert(schema.applications).values({
      userId: user.id, jobId: interviewing!.id, jobTitle: interviewing!.title, companyName: company!.name,
      appliedOn: "2026-09-10", status: "interview", history: [],
    });

    const page = await fetchRolePage(user.id, parseRolesFilters({ view: "user-shortlisted" }), false, null, 1);
    expect(page.total).toBe(2);
    const stages = new Map(page.visible.map(r => [r.job.id, r]));
    expect(stages.get(interviewing!.id)!.stage).toBe("in_process");
    expect(stages.get(interviewing!.id)!.applicationStatus).toBe("interview");
    expect(stages.get(justShortlisted!.id)!.stage).toBe("shortlisted");
    expect(stages.get(justShortlisted!.id)!.applicationStatus).toBeNull();
    expect(buildRoleRowVM(stages.get(interviewing!.id)!).stage).toBe("in_process");
  });
});
