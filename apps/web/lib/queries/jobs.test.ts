import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@col/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@col/db/migrate";
import { eq, sql } from "drizzle-orm";
import { ROLE_TABS, type RoleStatus } from "@col/core";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@col/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
vi.mock("@/lib/db", () => ({ db: () => database }));
import { appliedRoleCount, parseRolesFilters, buildRoleCompanies, buildRoleRowVM, fetchArchiveNotes, fetchRolePage, fetchRoleRows, filtersToQueryString, locationReasonText, parseSince, resolveRoleView, roleTabFor, scoreStateText, SORT_KEYS, type RoleCursor, type RoleRow } from "./jobs";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());

/** One account following one company with a role per entry, each carrying the given fit score. */
async function rolesWithFit(email: string, scores: Array<number | null>) {
  await database.execute(sql`truncate users, companies restart identity cascade`);
  const user: User = await ensureTestUser(database, email);
  const [company] = await database.insert(schema.companies).values({ name: "Acme", domain: "acme.test", homepageUrl: "https://acme.test" }).returning();
  const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://acme.test/jobs" }).returning();
  const inserted = await database.insert(schema.jobs).values(scores.map((_, i) => ({
    companyId: company!.id, sourceId: source!.id, externalKey: `id:${i}`, title: `Role ${i}`, normalizedTitle: `role ${i}`, url: `https://acme.test/jobs/${i}`,
  }))).returning();
  await database.insert(schema.userJobs).values(inserted.map((job, i) => ({ userId: user.id, jobId: job.id, keywordMatched: true, locationOk: true, inTable: true, fitScore: scores[i] ?? null })));
  return { user, jobs: inserted };
}

describe("fit ordering", () => {
  it("keeps unscored roles last in both directions", async () => {
    const { user } = await rolesWithFit("fit-order@example.com", [null, 20, 90]);
    const fits = async (sp: Record<string, string>) => (await fetchRoleRows(user.id, parseRolesFilters(sp), false)).map(r => r.job.fitScore);
    expect(await fits({ sort: "fit", dir: "desc" })).toEqual([90, 20, null]);
    expect(await fits({ sort: "fit", dir: "asc" })).toEqual([20, 90, null]);
    expect(await fits({ sort: "status", dir: "asc" })).toEqual([90, 20, null]);
  });
});

describe("inbox decisions", () => {
  it("shows only unreviewed roles by default and restores reset decisions", async () => {
    const { user, jobs: [skipped, applied, undecided] } = await rolesWithFit("inbox@example.com", [20, 20, 20]);
    const decision = (job: typeof skipped, value: "apply" | "skip") => ({ userId: user.id, jobId: job!.id, decision: value, jobTitle: job!.title, companyName: "Acme" });
    await database.insert(schema.decisions).values([decision(skipped, "skip"), decision(applied, "apply")]);
    const ids = async (sp: Record<string, string>) => (await fetchRoleRows(user.id, parseRolesFilters(sp), false)).map(r => r.job.id).sort();
    expect(await ids({})).toEqual([undecided!.id]);
    expect(await ids({ decision: "skip" })).toEqual([skipped!.id]);
    expect(await ids({ decision: "all" })).toHaveLength(3);
    // A reset decision is superseded, which puts the role back in the inbox.
    await database.update(schema.decisions).set({ superseded: true }).where(eq(schema.decisions.jobId, skipped!.id));
    expect(await ids({})).toEqual([skipped!.id, undecided!.id].sort());
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

  it("opens on Matched when both live tabs are empty, and on a populated Shortlisted tab", () => {
    const counts: Record<RoleStatus, number> = { "auto-matched": 3, "user-shortlisted": 2, "user-dismissed": 1, archived: 4 };
    expect(resolveRoleView({}, counts)).toBe("auto-matched");
    expect(resolveRoleView({}, { ...counts, "auto-matched": 0 })).toBe("user-shortlisted");
    expect(resolveRoleView({}, {})).toBe("auto-matched");
    expect(resolveRoleView({}, { "auto-matched": 0, "user-shortlisted": 0, archived: 17 })).toBe("auto-matched");
    // A link that names a view is answered whatever the counts say.
    expect(resolveRoleView({ view: "user-dismissed" }, counts)).toBe("user-dismissed");
    expect(resolveRoleView({ view: "user-shortlisted" }, { "auto-matched": 0, "user-shortlisted": 0 })).toBe("user-shortlisted");
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

describe("finding what I decided", () => {
  it("reads a since window from the URL and writes it back", () => {
    expect(parseSince("7d")).toBe(7);
    expect(parseSince("30d")).toBe(30);
    // Anything that is not a plain number of days, and anything silly, names no window at all.
    for (const raw of [undefined, "", "7", "d", "-7d", "0d", "999d", "7 days"]) expect(parseSince(raw)).toBeNull();
    expect(parseRolesFilters({ since: "7d" }).sinceDays).toBe(7);
    expect(parseRolesFilters({ since: "nonsense" }).sinceDays).toBeNull();
    expect(filtersToQueryString(parseRolesFilters({ since: "7d" }))).toContain("since=7d");
    expect(filtersToQueryString(parseRolesFilters({}))).not.toContain("since");
  });

  /** The two the Shortlisted and Dismissed tabs offer, read at the database rather than in JS. */
  it("sorts and filters by decision date in SQL", async () => {
    await database.execute(sql`truncate users, companies restart identity cascade`);
    const user: User = await ensureTestUser(database, "decided-sort@example.com");
    const [company] = await database.insert(schema.companies).values({ name: "Acme", domain: "acme.test", homepageUrl: "https://acme.test" }).returning();
    const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://acme.test/jobs" }).returning();
    const inserted = await database.insert(schema.jobs).values([
      { companyId: company!.id, sourceId: source!.id, externalKey: "id:old", title: "Old call", normalizedTitle: "old call", url: "https://acme.test/jobs/old" },
      { companyId: company!.id, sourceId: source!.id, externalKey: "id:new", title: "Recent call", normalizedTitle: "recent call", url: "https://acme.test/jobs/new" },
      { companyId: company!.id, sourceId: source!.id, externalKey: "id:none", title: "Undecided", normalizedTitle: "undecided", url: "https://acme.test/jobs/none" },
    ]).returning();
    const [older, newer, undecided] = inserted as [typeof inserted[number], typeof inserted[number], typeof inserted[number]];
    for (const job of [older, newer, undecided]) {
      await database.insert(schema.userJobs).values({ userId: user.id, jobId: job.id, keywordMatched: true, locationOk: true, inTable: true });
    }
    const days = (n: number) => new Date(Date.now() - n * 86400000);
    for (const [job, at] of [[older, days(20)], [newer, days(2)]] as const) {
      const [decision] = await database.insert(schema.decisions)
        .values({ userId: user.id, jobId: job.id, decision: "apply", jobTitle: job.title, companyName: "Acme" }).returning();
      await database.update(schema.decisions).set({ createdAt: at }).where(eq(schema.decisions.id, decision!.id));
    }

    const shortlisted = parseRolesFilters({ view: "user-shortlisted", sort: "decided" });
    const newestFirst = await fetchRolePage(user.id, shortlisted, false, null, 1);
    expect(newestFirst.total).toBe(2);
    expect(newestFirst.visible.map(r => r.job.id)).toEqual([newer.id, older.id]);
    const oldestFirst = await fetchRolePage(user.id, { ...shortlisted, dir: "asc" }, false, null, 1);
    expect(oldestFirst.visible.map(r => r.job.id)).toEqual([older.id, newer.id]);

    // "This week" is a window on the decision, so the undecided role is never in it.
    const thisWeek = await fetchRolePage(user.id, parseRolesFilters({ view: "user-shortlisted", sort: "decided", since: "7d" }), false, null, 1);
    expect(thisWeek.total).toBe(1);
    expect(thisWeek.visible.map(r => r.job.id)).toEqual([newer.id]);
    // Matched is untouched by either: it is the tab with no decisions on it.
    expect((await fetchRolePage(user.id, parseRolesFilters({ view: "auto-matched" }), false, null, 1)).visible.map(r => r.job.id)).toEqual([undecided.id]);
  });

  /** R-7.5: the export reads the table's own SQL, so the file cannot disagree with the screen. */
  it("gives the export the same rows, in the same order, as the page it exports", async () => {
    await database.execute(sql`truncate users, companies restart identity cascade`);
    const user: User = await ensureTestUser(database, "csv-parity@example.com");
    const [company] = await database.insert(schema.companies).values({ name: "Acme", domain: "acme.test", homepageUrl: "https://acme.test" }).returning();
    const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://acme.test/jobs" }).returning();
    const jobRows = await database.insert(schema.jobs).values(Array.from({ length: 12 }, (_, i) => ({
      companyId: company!.id, sourceId: source!.id, externalKey: `id:${i}`, title: `Role ${String(i).padStart(2, "0")}`,
      normalizedTitle: `role ${i}`, url: `https://acme.test/jobs/${i}`, location: i % 2 ? "London" : "Leeds",
    }))).returning();
    await database.insert(schema.userJobs).values(jobRows.map((job, i) => ({
      userId: user.id, jobId: job.id, keywordMatched: true, locationOk: true, inTable: true, fitScore: i * 5,
    })));

    for (const filters of [parseRolesFilters({ sort: "title" }), parseRolesFilters({ sort: "fit", dir: "desc" }), parseRolesFilters({ q: "role 0", sort: "company" })]) {
      const page = await fetchRolePage(user.id, filters, false, null, 1);
      // Read it the way the export does — in blocks — and the two must line up exactly.
      const blocks: string[] = [];
      for (let offset = 0; ; offset += 5) {
        const block = await fetchRoleRows(user.id, filters, false, { offset, limit: 5 });
        blocks.push(...block.map(r => r.job.id));
        if (block.length < 5) break;
      }
      expect(blocks).toEqual(page.visible.map(r => r.job.id));
      expect(blocks).toHaveLength(page.total);
    }
  });
});

describe("why a role is in the table", () => {
  it("names the term that admitted it, or remote, or the filter that names no location", () => {
    expect(locationReasonText({ ok: true, terms: ["London"], remote: false }, true, false)).toBe('Matches your location filter: London.');
    expect(locationReasonText({ ok: true, terms: ["remote"], remote: true }, true, false)).toBe("Remote, and your filter allows remote roles.");
    expect(locationReasonText({ ok: true, terms: [], remote: false }, false, false)).toBe("Your filter names no location, so every location passes.");
    expect(locationReasonText({ ok: true, terms: [], remote: true }, false, false)).toContain("Remote");
    // A role can sit in the table against the filter: because you added it, or because you decided on it.
    expect(locationReasonText({ ok: false, terms: [], remote: false }, true, true)).toContain("added it by its URL");
    expect(locationReasonText({ ok: false, terms: [], remote: false }, true, false)).toContain("decided on it");
  });
});

describe("what a score state means", () => {
  const scored = { fitScore: 72, scoreState: "scored" as const, scoreStateAt: new Date() };
  const now = new Date("2026-09-19T12:00:00Z");
  const queuedAt = (msAgo: number) => ({ fitScore: null, scoreState: "queued" as const, scoreStateAt: new Date(now.getTime() - msAgo) });

  it("distinguishes a request from worker-admitted work without guessing from its age", () => {
    expect(scoreStateText({ fitScore: null, scoreState: "requested", scoreStateAt: now })).toBe("Score pending; review manually");
    expect(scoreStateText(queuedAt(5_000))).toBe("Waiting for scoring; review manually");
    // A provider batch may wait much longer than one live score task's two-minute deadline.
    expect(scoreStateText(queuedAt(2 * 60 * 60_000))).toBe("Waiting for scoring; review manually");
    expect(scoreStateText({ fitScore: null, scoreState: "queued", scoreStateAt: null })).toBe("Waiting for scoring; review manually");

    expect(scoreStateText({ fitScore: null, scoreState: "budget", scoreStateAt: now })).toBe("not scored: budget spent");
    expect(scoreStateText({ fitScore: null, scoreState: "verification", scoreStateAt: now })).toBe("Confirm your email to start scoring");
    expect(scoreStateText({ fitScore: null, scoreState: "unavailable", scoreStateAt: now })).toBe("AI scoring unavailable; review manually");
    expect(scoreStateText({ fitScore: null, scoreState: "failed", scoreStateAt: now })).toBe("Could not score; review manually");
    expect(scoreStateText({ fitScore: null, scoreState: "scored", scoreStateAt: now })).toBe("No fit score returned; review manually");
    expect(scoreStateText({ fitScore: null, scoreState: "closed", scoreStateAt: now })).toBe("closed");
    expect(scoreStateText({ fitScore: null, scoreState: "ineligible", scoreStateAt: now })).toBe("not scored: outside your filters");
    // Rows from before the column existed have nothing recorded, which is not the same as waiting.
    expect(scoreStateText({ fitScore: null, scoreState: null, scoreStateAt: null })).toBe("not scored yet");
  });

  it("keeps a previous score visible while describing an update's actual state", () => {
    expect(scoreStateText(scored)).toBeNull();
    expect(scoreStateText({ ...scored, scoreState: null, scoreStateAt: null })).toBeNull();
    expect(scoreStateText({ ...scored, scoreState: "requested" })).toBe("Previous score; update pending");
    expect(scoreStateText({ ...scored, scoreState: "queued" })).toBe("Previous score; update pending");
    expect(scoreStateText({ ...scored, scoreState: "unavailable" })).toBe("Previous score; AI update unavailable");
    expect(scoreStateText({ ...scored, scoreState: "budget" })).toBe("Previous score; update stopped: budget spent");
    expect(scoreStateText({ ...scored, scoreState: "verification" })).toBe("Previous score; update waits for email confirmation");
    expect(scoreStateText({ ...scored, scoreState: "failed" })).toBe("Previous score; update failed; review manually");
  });

  it("carries the state and its words into the view model", () => {
    const base = {
      job: { id: "job-1", title: "Operations Director", url: "https://acme.test/jobs/1", location: "London", locations: ["London"], remote: false, department: null, employmentType: null, salaryText: null, keywordTerms: [], fitScore: null, fitVerdict: null, fitRationale: null, status: "open", postedAt: null, firstSeenAt: new Date("2026-09-18T00:00:00Z"), closedAt: null, seeded: false, origin: "scan", addedBy: null, scoreState: "budget", scoreStateAt: now },
      company: { id: "company-1", name: "Acme", faviconUrl: null, logoFetchedAt: null, homepageUrl: "https://acme.test", domain: "acme.test" },
      sourceType: "html", decision: null, stage: "matched", applicationStatus: null,
    } as unknown as RoleRow;
    const vm = buildRoleRowVM(base, now);
    expect(vm.scoreState).toBe("budget");
    expect(vm.scoreStateText).toBe("not scored: budget spent");
    const withScore = buildRoleRowVM({ ...base, job: { ...base.job, fitScore: 61, scoreState: "scored" } } as RoleRow, now);
    expect(withScore.scoreStateText).toBeNull();

    // The row names its company and what its live-for counts from; the rest of the company, and the
    // sentence, travel once per page.
    expect(vm).toMatchObject({ companyId: "company-1", companyName: "Acme", liveForBasis: "first_seen", liveForText: expect.stringMatching(/\*$/) });
    expect(Object.keys(vm).filter(key => /^company(?!Id$|Name$)|Title$|Label$|^events$|^sourceType$|^locationOk$/.test(key))).toEqual([]);
    const posted = buildRoleRowVM({ ...base, job: { ...base.job, postedAt: new Date("2026-09-18T00:00:00Z") } } as RoleRow, now);
    expect(posted.liveForBasis).toBe("posted");
    const logo = new Date("2026-09-10T00:00:00Z");
    const companies = buildRoleCompanies([
      base,
      { ...base, job: { ...base.job, id: "job-2" } } as RoleRow,
      { ...base, company: { id: "company-2", name: "Beta", faviconUrl: "https://beta.test/favicon.ico", logoFetchedAt: logo, homepageUrl: "https://beta.test", domain: "beta.test" } } as RoleRow,
    ]);
    expect(companies).toEqual({
      "company-1": { iconSrc: null, domain: "acme.test", homepageUrl: "https://acme.test" },
      // The captured logo before the stored favicon, exactly as the company page draws it.
      "company-2": { iconSrc: `/api/companies/company-2/logo?v=${logo.getTime()}`, domain: "beta.test", homepageUrl: "https://beta.test" },
    });
  });

  /** The column is on this account's own view of the role, so the table's read has to carry it. */
  it("reads the state from the account's view of the role", async () => {
    await database.execute(sql`truncate users, companies restart identity cascade`);
    const user: User = await ensureTestUser(database, "score-state@example.com");
    const [company] = await database.insert(schema.companies).values({ name: "Acme", domain: "acme.test", homepageUrl: "https://acme.test" }).returning();
    const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://acme.test/jobs" }).returning();
    const [job] = await database.insert(schema.jobs).values({
      companyId: company!.id, sourceId: source!.id, externalKey: "id:1", title: "Operations Director",
      normalizedTitle: "operations director", url: "https://acme.test/jobs/1",
    }).returning();
    await database.insert(schema.userJobs).values({
      userId: user.id, jobId: job!.id, keywordMatched: true, locationOk: true, inTable: true,
      scoreState: "budget", scoreStateAt: new Date(),
    });

    const page = await fetchRolePage(user.id, parseRolesFilters({}), false, null, 1);
    expect(page.visible[0]!.job.scoreState).toBe("budget");
    expect(buildRoleRowVM(page.visible[0]!).scoreStateText).toBe("not scored: budget spent");
  });
});

describe("the shortlist's own breakdown", () => {
  it("counts every stage that means an application was sent, and no other", () => {
    // "Shortlisted 12 · 3 applied": applying is a CV being written, not an application.
    expect(appliedRoleCount({ applied: 2, in_process: 1 })).toBe(3);
    expect(appliedRoleCount({ applied: 1, in_process: 1, accepted: 1, rejected: 1 })).toBe(4);
    expect(appliedRoleCount({ matched: 9, shortlisted: 12, applying: 4, dismissed: 3 })).toBe(0);
    expect(appliedRoleCount({})).toBe(0);
  });
});

describe("a role's archive notes", () => {
  /** One posting followed by several accounts: every account's events hang off the one job. */
  async function sharedPosting() {
    await database.execute(sql`truncate users, companies restart identity cascade`);
    const me: User = await ensureTestUser(database, "events-me@example.com");
    const other: User = await ensureTestUser(database, "events-other@example.com", "member");
    const [company] = await database.insert(schema.companies).values({ name: "Acme", domain: "acme.test", homepageUrl: "https://acme.test" }).returning();
    const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://acme.test/jobs" }).returning();
    const jobsInserted = await database.insert(schema.jobs).values([1, 2, 3].map((n) => ({
      companyId: company!.id, sourceId: source!.id, externalKey: `id:${n}`, title: `Role ${n}`, normalizedTitle: `role ${n}`, url: `https://acme.test/jobs/${n}`,
    }))).returning();
    return { me, other, jobs: jobsInserted };
  }
  const at = (second: number) => new Date(1_700_000_000_000 + second * 1000);

  const archived = (reason: string) => ({ action: "archived", reason });

  it("never returns another account's events, however many it has", async () => {
    const { me, other, jobs: [job] } = await sharedPosting();
    await database.insert(schema.jobEvents).values([
      ...Array.from({ length: 20 }, (_, i) => ({ jobId: job!.id, userId: other.id, type: "updated" as const, payload: archived(`other ${i}`), at: at(100 + i) })),
      { jobId: job!.id, userId: null, type: "updated" as const, payload: archived("shared"), at: at(1) },
      { jobId: job!.id, userId: me.id, type: "updated" as const, payload: archived("mine"), at: at(2) },
    ]);
    expect(await fetchArchiveNotes(me.id, job!.id)).toEqual(["Archived: mine", "Archived: shared"]);
  });

  it("merges shared and own events newest first and caps them across both", async () => {
    const { me, jobs: [job] } = await sharedPosting();
    // Four of each, interleaved in time: the newest six of the eight, in order.
    await database.insert(schema.jobEvents).values([1, 2, 3, 4, 5, 6, 7, 8].map((second) => ({
      jobId: job!.id, userId: second % 2 ? null : me.id, type: "updated" as const, payload: archived(String(second)), at: at(second),
    })));
    expect(await fetchArchiveNotes(me.id, job!.id, 6)).toEqual([8, 7, 6, 5, 4, 3].map((second) => `Archived: ${second}`));
  });

  it("keeps only the events that put the role away, and names who did when no reason was given", async () => {
    const { me, jobs: [job, quiet] } = await sharedPosting();
    await database.insert(schema.jobEvents).values([
      { jobId: job!.id, userId: me.id, type: "updated" as const, payload: { action: "archived" }, at: at(3) },
      { jobId: job!.id, userId: me.id, type: "updated" as const, payload: { action: "restored" }, at: at(4) },
    ]);
    expect(await fetchArchiveNotes(me.id, job!.id)).toEqual(["Archived: Put away by you"]);
    expect(await fetchArchiveNotes(me.id, quiet!.id)).toEqual([]);
  });
});

describe("reading a view block by block", () => {
  /**
   * The export reads a view 500 rows at a time after the last row it wrote. Every order the table
   * offers has ties, and several have nulls, so the cursor must place both exactly as the `order by`
   * does; and a timestamp can differ in its microseconds alone, which a JavaScript date cannot hold.
   */
  it("gives every sort, both ways, the same rows in the same order as an offset read", async () => {
    await database.execute(sql`truncate users, companies restart identity cascade`);
    const user: User = await ensureTestUser(database, "keyset@example.com");
    const now = new Date("2026-09-23T12:00:00Z");
    const [acme, beta] = await database.insert(schema.companies).values([
      { name: "Acme", domain: "acme.test", homepageUrl: "https://acme.test" },
      { name: "Beta", domain: "beta.test", homepageUrl: "https://beta.test" },
    ]).returning();
    const sources = await database.insert(schema.careerSources).values([
      { companyId: acme!.id, type: "html", url: "https://acme.test/jobs" },
      { companyId: beta!.id, type: "html", url: "https://beta.test/jobs" },
    ]).returning();
    const fits = [null, 50, 50, 80, null, 20, 50, null, 80, 10, 50, null, 30];
    const titles = ["Ops", "Ops", "Lead", "Lead", "Ops", "Chief", "Lead", "Ops", "Chief", "Ops", "Lead", "Ops", "Chief"];
    const locations = ["London", null, "Leeds", "London", null, "London", "Leeds", null, "London", "Leeds", null, "London", "Leeds"];
    const inserted = await database.insert(schema.jobs).values(fits.map((_, i) => ({
      companyId: (i % 3 ? acme : beta)!.id, sourceId: sources[i % 3 ? 0 : 1]!.id, externalKey: `id:${i}`,
      title: titles[i]!, normalizedTitle: titles[i]!.toLowerCase(), url: `https://acme.test/jobs/${i}`, location: locations[i],
      status: i % 5 === 4 ? "closed" as const : "open" as const, closedAt: i % 5 === 4 ? new Date("2026-09-20T00:00:00Z") : null,
      postedAt: i % 4 === 0 ? new Date("2026-08-01T00:00:00Z") : null,
    }))).returning();
    // Three moments, two of them a microsecond apart, and ties on each: new and active roles both.
    const moments = ["2026-09-20 08:00:00.000100+00", "2026-09-20 08:00:00.000200+00", "2026-08-10 08:00:00+00"];
    for (const [i, job] of inserted.entries()) {
      await database.execute(sql`update jobs set first_seen_at = ${moments[i % 3]}::timestamptz where id = ${job.id}`);
    }
    await database.insert(schema.userJobs).values(inserted.map((job, i) => ({
      userId: user.id, jobId: job.id, keywordMatched: true, locationOk: true, inTable: true, fitScore: fits[i],
    })));
    // Some roles decided, two of them a microsecond apart and two at the same moment; the rest never.
    for (const [i, job] of inserted.entries()) {
      if (i % 3 === 2) continue;
      if (i > 8) continue;
      const [decision] = await database.insert(schema.decisions)
        .values({ userId: user.id, jobId: job.id, decision: i % 2 ? "apply" : "skip", jobTitle: job.title, companyName: "Acme" }).returning();
      await database.execute(sql`update decisions set created_at = ${moments[i % 2]}::timestamptz where id = ${decision!.id}`);
    }

    for (const sort of SORT_KEYS) {
      for (const dir of ["asc", "desc"] as const) {
        const filters = parseRolesFilters({ sort, dir, decision: "all" });
        const whole = (await fetchRoleRows(user.id, filters, false, { limit: 100, now })).map((row) => row.job.id);
        expect(whole, `${sort} ${dir}`).toHaveLength(inserted.length);
        const blocks: string[] = [];
        let after: RoleCursor | null = null;
        for (;;) {
          const block = await fetchRoleRows(user.id, filters, false, { after, limit: 2, now });
          blocks.push(...block.map((row) => row.job.id));
          if (block.length < 2) break;
          after = block.at(-1)!.cursor;
        }
        expect(blocks, `${sort} ${dir}`).toEqual(whole);
      }
    }
  });
});
