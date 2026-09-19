/**
 * The applications table's query, against the database: one row per company-role, whatever the
 * role's progress is spread across, and the legacy records that have no posting behind them at
 * all gathered into rows of their own.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, subscribeToCompany, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@christopher/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
import { applicationStaleHint, listPipeline, pipelineCompany, pipelineCvQuotes, pipelineDueCount, pipelineFilter, pipelineStageCounts } from "./applications";

const LIBRARY = {
  name: "Test Candidate",
  contact: "London",
  profile: "Operations leader",
  entries: [{ id: "one", kind: "experience" as const, heading: "Director · Acme", details: "Led a team", confirmedResponsibilities: ["Led a team"] }],
};

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
}, 120_000);
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate cv_libraries, cv_drafts, companies, decisions, tasks, settings, users restart identity cascade`);
  user = await ensureTestUser(database);
});

/** A followed company with one posting in this account's table. */
async function role(title = "Operations Manager", companyName = "Acme") {
  const slug = `${companyName.toLowerCase().replace(/\W+/g, "-")}-${title.length}`;
  const [company] = await database.insert(schema.companies).values({ name: companyName, domain: `${slug}.example`, homepageUrl: `https://${slug}.example` }).returning();
  const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: `https://${slug}.example/jobs` }).returning();
  const [job] = await database.insert(schema.jobs).values({
    companyId: company!.id, sourceId: source!.id, title, normalizedTitle: title.toLowerCase(),
    externalKey: title, url: `https://${slug}.example/jobs/${title.length}`,
  }).returning();
  await subscribeToCompany(database, user.id, company!.id);
  await database.insert(schema.userJobs).values({ userId: user.id, jobId: job!.id, inTable: true, keywordMatched: true });
  return { company: company!, job: job! };
}

const shortlist = (jobId: string, decision: "apply" | "skip" = "apply") =>
  database.insert(schema.decisions).values({ userId: user.id, jobId, decision, reason: decision === "skip" ? "Not for me" : "", jobTitle: "Operations Manager", companyName: "Acme" });

const buildCv = (jobId: string | null, over: Partial<typeof schema.cvDrafts.$inferInsert> = {}) =>
  database.insert(schema.cvDrafts).values({
    userId: user.id, jobId, jobTitle: "Operations Manager", companyName: "Acme", jobDescription: "Lead a team",
    libraryVersion: 1, librarySnapshot: LIBRARY, model: "test", status: "ready", revision: 1, ...over,
  }).returning();

const record = (jobId: string | null, status: typeof schema.applications.$inferInsert["status"], over: Partial<typeof schema.applications.$inferInsert> = {}) =>
  database.insert(schema.applications).values({
    userId: user.id, jobId, jobTitle: "Operations Manager", companyName: "Acme", appliedOn: "2026-09-01", status,
    history: [{ status: status!, at: "2026-09-01T09:00:00.000Z", notes: "" }], ...over,
  }).returning();

it("reads one row per pursued role, at the stage the decision, the CV and the application make it", async () => {
  const { job, company } = await role();
  // A matched role nobody has decided on is not being pursued, so it is not in this table at all.
  expect((await listPipeline(user.id, { filter: "all" })).rows).toHaveLength(0);

  await shortlist(job.id);
  const shortlisted = await listPipeline(user.id);
  expect(shortlisted.rows.map((row) => [row.stage, row.jobTitle, row.companyName])).toEqual([["shortlisted", "Operations Manager", "Acme"]]);
  expect(shortlisted.rows[0]!.jobId).toBe(job.id);
  expect(shortlisted.rows[0]!.companyId).toBe(company.id);
  expect(shortlisted.rows[0]!.jobUrl).toBe(job.url);
  expect(shortlisted.rows[0]!.cv).toBeNull();
  expect(shortlisted.counts).toEqual({ active: 1, closed: 0, all: 1 });

  // A CV for the role is the difference between Shortlisted and Applying, and the row carries it.
  const [draft] = await buildCv(job.id, { revision: 3, finalisedAt: new Date("2026-09-10T09:00:00Z") });
  const applying = await listPipeline(user.id);
  expect(applying.rows[0]!.stage).toBe("applying");
  expect(applying.rows[0]!.cv).toMatchObject({ id: draft!.id, status: "ready", revision: 3 });
  expect(applying.rows[0]!.cv!.finalisedAt).not.toBeNull();
  expect(applying.rows[0]!.archivedCvId).toBeNull();

  // The predecessor a rebuild retains is what "Restore previous CV" puts back, by its own id.
  const [previous] = await buildCv(job.id, { revision: 2, archivedAt: new Date("2026-09-09T09:00:00Z"), createdAt: new Date("2026-09-09T09:00:00Z") });
  expect((await listPipeline(user.id)).rows[0]!.archivedCvId).toBe(previous!.id);

  // Screening, interview and offer are one stage, with the step named beside it.
  await record(job.id, "interview", { notes: "First round booked", cvId: draft!.id, pdfBase64: "JVBER" });
  const inProcess = await listPipeline(user.id);
  expect(inProcess.rows[0]!.stage).toBe("in_process");
  expect(inProcess.rows[0]!.application).toMatchObject({ status: "interview", notes: "First round booked", hasPdf: true, cvId: draft!.id });
  expect(inProcess.rows[0]!.application!.history).toHaveLength(1);
});

it("lists a dismissed role under Closed only when it was pursued, never one merely passed on", async () => {
  const { job } = await role();
  await shortlist(job.id, "skip");
  // Passed on from Roles, nothing else: not an application, so not here at all.
  for (const filter of ["active", "closed", "all"] as const) expect((await listPipeline(user.id, { filter })).rows).toHaveLength(0);
  expect((await listPipeline(user.id, { filter: "closed" })).counts).toEqual({ active: 0, closed: 0, all: 0 });
  // Withdrawn after applying: dismissed, and a closed application.
  await record(job.id, "withdrawn");
  expect((await listPipeline(user.id)).rows).toHaveLength(0);
  const closed = await listPipeline(user.id, { filter: "closed" });
  expect(closed.rows.map((row) => row.stage)).toEqual(["dismissed"]);
  expect(closed.counts).toEqual({ active: 0, closed: 1, all: 1 });
  // A CV alone is also a pursuit: dismissed after building one still shows as closed.
  const { job: other } = await role("Head of Ops");
  await shortlist(other.id, "skip");
  await buildCv(other.id, { archivedAt: new Date() });
  expect((await listPipeline(user.id, { filter: "closed" })).rows.map((row) => row.jobId).sort()).toEqual([job.id, other.id].sort());
});

it("gathers records with no posting behind them into one row per company and role", async () => {
  // Two applications for the same company-role: the newest is what the row says.
  await record(null, "applied", { createdAt: new Date("2026-08-01T09:00:00Z") });
  await record(null, "rejected", { createdAt: new Date("2026-09-02T09:00:00Z"), history: [{ status: "rejected", at: "2026-09-02T10:00:00.000Z", notes: "No" }] });
  // Whitespace and case are not a different role: the key is the CV retention key.
  await buildCv(null, { companyName: "acme", jobTitle: "Operations  Manager", createdAt: new Date("2026-08-20T09:00:00Z") });

  const rows = (await listPipeline(user.id, { filter: "all" })).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.jobId).toBeNull();
  expect(rows[0]!.companyId).toBeNull();
  expect(rows[0]!.companyIcon).toBeNull();
  expect(rows[0]!.jobUrl).toBeNull();
  expect(rows[0]!.stage).toBe("rejected");
  expect(rows[0]!.application!.status).toBe("rejected");
  expect(rows[0]!.cv).not.toBeNull();
  expect(rows[0]!.updatedAt.toISOString()).toBe("2026-09-02T10:00:00.000Z");
});

it("treats a saved CV with no posting as a role being applied for", async () => {
  await buildCv(null, { companyName: "Legacy Co", jobTitle: "Legacy Role" });
  const page = await listPipeline(user.id);
  expect(page.rows.map((row) => [row.stage, row.companyName, row.jobTitle])).toEqual([["applying", "Legacy Co", "Legacy Role"]]);
  expect(page.rows[0]!.application).toBeNull();
  expect(page.counts.active).toBe(1);
});

it("orders by how far a role has got, then by what moved last, and pages at fifty", async () => {
  const { job } = await role("Head of Delivery");
  await shortlist(job.id);
  for (let n = 0; n < 51; n++) {
    const at = new Date(Date.UTC(2026, 8, 1, 0, n));
    await record(null, "applied", { jobTitle: `Legacy role ${n}`, createdAt: at, history: [{ status: "applied", at: at.toISOString(), notes: "" }] });
  }

  const first = await listPipeline(user.id);
  expect(first.total).toBe(52);
  expect(first.pageCount).toBe(2);
  expect(first.rows).toHaveLength(50);
  // Shortlisted outranks applied, and within a stage the most recently moved comes first.
  expect(first.rows[0]!.stage).toBe("shortlisted");
  expect(first.rows[1]!.jobTitle).toBe("Legacy role 50");
  const second = await listPipeline(user.id, { page: "2" });
  expect(second.page).toBe(2);
  expect(second.rows).toHaveLength(2);
  // The order runs across the page boundary: the second page continues where the first stopped,
  // which is the thing paging in SQL rather than in JS has to keep true.
  expect(first.rows.at(-1)!.jobTitle).toBe("Legacy role 2");
  expect(second.rows.map((row) => row.jobTitle)).toEqual(["Legacy role 1", "Legacy role 0"]);
  // Every row is on exactly one page, and the counts are the whole set, not the page.
  const keys = [...first.rows, ...second.rows].map((row) => row.key);
  expect(new Set(keys).size).toBe(52);
  expect(second.counts).toEqual({ active: 52, closed: 0, all: 52 });
  // A page beyond the end clamps rather than showing nothing.
  expect((await listPipeline(user.id, { page: "99" })).page).toBe(2);
});

it("counts every stage for this account, in SQL, and never counts a matched role", async () => {
  const { job: shortlisted } = await role("Head of Delivery");
  await shortlist(shortlisted.id);
  const { job: applying } = await role("Operations Lead");
  await shortlist(applying.id);
  await buildCv(applying.id);
  const { job: closed } = await role("Head of Ops");
  await shortlist(closed.id);
  await record(closed.id, "rejected");
  // Matched, decided on by nobody: in the roles table, never in this count.
  await role("Analyst");
  // Two records with no posting behind them, at one stage each.
  await record(null, "interview", { jobTitle: "Legacy interview" });
  await record(null, "accepted", { jobTitle: "Legacy accepted" });

  expect(await pipelineStageCounts(user.id)).toEqual({
    matched: 0, shortlisted: 1, applying: 1, applied: 0, in_process: 1, accepted: 1, rejected: 1, dismissed: 0,
  });
  // The segments the page shows are the same numbers added up, and the strip in its header is
  // the same reading again rather than a second count of the lifecycle.
  const page = await listPipeline(user.id);
  expect(page.counts).toEqual({ active: 3, closed: 2, all: 5 });
  expect(page.stages).toEqual(await pipelineStageCounts(user.id));
  const other = await ensureTestUser(database, "other-counts@example.com", "member");
  expect(await pipelineStageCounts(other.id)).toEqual({
    matched: 0, shortlisted: 0, applying: 0, applied: 0, in_process: 0, accepted: 0, rejected: 0, dismissed: 0,
  });
});

it("counts the next steps due in the coming week, and never another account's", async () => {
  const now = new Date("2026-09-19T12:00:00.000Z");
  const { job: soon, company } = await role("Head of Delivery");
  await shortlist(soon.id);
  await record(soon.id, "interview", { nextAction: "Send references", nextActionOn: "2026-09-23" });
  // A step whose day has gone by is the most due thing on the page, so it is counted too.
  const { job: overdue } = await role("Operations Lead");
  await shortlist(overdue.id);
  await record(overdue.id, "interview", { nextAction: "Second interview", nextActionOn: "2026-09-15" });
  // Next month is not this week, and a step with no day is not due on any of them.
  const { job: later } = await role("Head of Ops");
  await shortlist(later.id);
  await record(later.id, "applied", { nextAction: "Chase the recruiter", nextActionOn: "2026-10-30" });
  const { job: undated } = await role("Delivery Lead");
  await shortlist(undated.id);
  await record(undated.id, "applied", { nextAction: "Chase the recruiter" });
  // A settled application owes nothing, however recent the note left on it.
  const { job: done } = await role("Programme Lead");
  await shortlist(done.id);
  await record(done.id, "rejected", { nextAction: "Ask for feedback", nextActionOn: "2026-09-20" });

  expect(await pipelineDueCount(user.id, { now })).toBe(2);
  // Scoped to a company the way the table is: by its catalogue id for a role with a posting
  // behind it, and by name for a record without one.
  await record(null, "applied", { companyName: "  acme ", jobTitle: "Legacy at Acme", nextAction: "Send the portfolio", nextActionOn: "2026-09-20" });
  expect(await pipelineDueCount(user.id, { now })).toBe(3);
  expect(await pipelineDueCount(user.id, { company: { id: company.id, name: "Acme" }, now })).toBe(2);
  const other = await ensureTestUser(database, "other-due@example.com", "member");
  expect(await pipelineDueCount(other.id, { now })).toBe(0);
});

it("hands each row the next step stored on it", async () => {
  const { job } = await role();
  await shortlist(job.id);
  await record(job.id, "interview", { nextAction: "Send references", nextActionOn: "2026-09-23" });
  await record(null, "applied", { jobTitle: "Legacy role", nextAction: "Chase the recruiter" });
  const rows = (await listPipeline(user.id, { filter: "all" })).rows;
  expect(rows.find((row) => row.jobId === job.id)!.application).toMatchObject({ nextAction: "Send references", nextActionOn: "2026-09-23" });
  expect(rows.find((row) => row.jobTitle === "Legacy role")!.application).toMatchObject({ nextAction: "Chase the recruiter", nextActionOn: null });
});

it("filters to one company, by its id for a posting and by its name for a record without one", async () => {
  const { job: acme, company } = await role("Head of Delivery");
  await shortlist(acme.id);
  const { job: other } = await role("Head of Delivery", "Globex");
  await shortlist(other.id);
  // A record with no posting behind it belongs to the company whose name it carries — the same
  // case- and whitespace-insensitive reading the CV retention key uses.
  await record(null, "applied", { companyName: "  acme ", jobTitle: "Legacy at Acme" });
  await record(null, "applied", { companyName: "Globex", jobTitle: "Legacy at Globex" });

  expect(await pipelineCompany(company.id)).toEqual({ id: company.id, name: "Acme" });
  const filtered = await listPipeline(user.id, { filter: "all", company: { id: company.id, name: "Acme" } });
  expect(filtered.rows.map((row) => row.jobTitle).sort()).toEqual(["Head of Delivery", "Legacy at Acme"]);
  expect(filtered.counts).toEqual({ active: 2, closed: 0, all: 2 });
  expect(filtered.total).toBe(2);
  // Unfiltered, all four are there; an id the catalogue does not know is no company at all.
  expect((await listPipeline(user.id, { filter: "all" })).total).toBe(4);
  expect(await pipelineCompany(crypto.randomUUID())).toBeNull();
});

it("prices a build for every role on the page, and refuses the ones the budget will not admit", async () => {
  const { job: cheap } = await role("Head of Delivery");
  await shortlist(cheap.id);
  const { job: dear } = await role("Operations Lead");
  await shortlist(dear.id);
  await database.update(schema.jobs).set({ descriptionText: "Lead a team. " }).where(eq(schema.jobs.id, cheap.id));
  await database.update(schema.jobs).set({ descriptionText: "Lead a team. ".repeat(2_000) }).where(eq(schema.jobs.id, dear.id));
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: LIBRARY });
  // A record with no posting behind it has nothing to build from, so it is never quoted.
  await record(null, "applied", { jobTitle: "Legacy role" });

  const rows = (await listPipeline(user.id, { filter: "all" })).rows;
  const quotes = await pipelineCvQuotes(user.id, rows);
  expect(Object.keys(quotes).sort()).toEqual([cheap.id, dear.id].sort());
  // One Library, measured once; the description is what makes one role dearer than another.
  expect(quotes[cheap.id]!.libraryBytes).toBe(quotes[dear.id]!.libraryBytes);
  expect(quotes[dear.id]!.estimateUsd).toBeGreaterThan(quotes[cheap.id]!.estimateUsd);
  expect(quotes[cheap.id]!.refusal).toBeNull();
  expect(quotes[cheap.id]!.leftUsd).toBe(quotes[cheap.id]!.limitUsd);

  // A budget with cents left refuses both, in the worker's own words.
  await database.insert(schema.userSettings).values({ userId: user.id, key: "aiBudgetUsd", value: 0.01 });
  const broke = await pipelineCvQuotes(user.id, rows);
  expect(broke[cheap.id]!.refusal).toMatch(/^This build needs about \$\d+\.\d\d of AI budget; your budget of \$0\.01 has \$0\.01 left this month/);
  expect(broke[dear.id]!.refusal).not.toBeNull();
  // Nothing to price is no query at all.
  expect(await pipelineCvQuotes(user.id, [{ jobId: null }])).toEqual({});
});

it("hints at a row nobody has touched for a fortnight, and only where silence means something", () => {
  const now = new Date("2026-09-19T12:00:00Z");
  const at = (days: number) => new Date(now.getTime() - days * 86_400_000);
  expect(applicationStaleHint({ stage: "applied", updatedAt: at(13) }, now)).toBeNull();
  expect(applicationStaleHint({ stage: "applied", updatedAt: at(14) }, now)).toBe("No update for 2 weeks");
  expect(applicationStaleHint({ stage: "in_process", updatedAt: at(25) }, now)).toBe("No update for 3 weeks");
  // A shortlist nobody has acted on is untouched, not stale; an outcome is not waiting on anyone.
  for (const stage of ["shortlisted", "applying", "accepted", "rejected", "dismissed"] as const)
    expect(applicationStaleHint({ stage, updatedAt: at(90) }, now)).toBeNull();
});

it("never shows one account's roles to another", async () => {
  const { job } = await role();
  await shortlist(job.id);
  const other = await ensureTestUser(database, "other-pipeline@example.com", "member");
  expect((await listPipeline(other.id, { filter: "all" })).rows).toHaveLength(0);
  expect((await listPipeline(other.id, { filter: "all" })).counts.all).toBe(0);
  // The other account following the same company still sees nothing it has not decided on.
  await subscribeToCompany(database, other.id, (await database.select().from(schema.companies).where(eq(schema.companies.name, "Acme")))[0]!.id);
  await database.insert(schema.userJobs).values({ userId: other.id, jobId: job.id, inTable: true, keywordMatched: true });
  expect((await listPipeline(other.id, { filter: "all" })).rows).toHaveLength(0);
});

it("answers with one of the three segments, whatever the link says", () => {
  expect(pipelineFilter(undefined)).toBe("active");
  expect(pipelineFilter("closed")).toBe("closed");
  expect(pipelineFilter(["all"])).toBe("all");
  expect(pipelineFilter("nonsense")).toBe("active");
});

it("dates a role by its decision when nothing else has happened to it", async () => {
  const { job } = await role();
  await shortlist(job.id);
  const [decision] = await database.select().from(schema.decisions).where(and(eq(schema.decisions.userId, user.id), eq(schema.decisions.jobId, job.id)));
  const [row] = (await listPipeline(user.id)).rows;
  expect(row!.updatedAt.toISOString()).toBe(decision!.createdAt.toISOString());
});
