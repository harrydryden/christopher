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
import { listPipeline, pipelineFilter } from "./applications";

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
async function role(title = "Operations Manager") {
  const [company] = await database.insert(schema.companies).values({ name: "Acme", domain: `acme-${title.length}.example`, homepageUrl: "https://acme.example" }).returning();
  const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://acme.example/jobs" }).returning();
  const [job] = await database.insert(schema.jobs).values({
    companyId: company!.id, sourceId: source!.id, title, normalizedTitle: title.toLowerCase(),
    externalKey: title, url: `https://acme.example/jobs/${title.length}`,
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
  // A page beyond the end clamps rather than showing nothing.
  expect((await listPipeline(user.id, { page: "99" })).page).toBe(2);
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
