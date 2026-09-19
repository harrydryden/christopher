/**
 * The role's stage, read at the database: one expression over this account's `user_jobs` row, its
 * active decision, its live CV and its newest application — with the application deciding whenever
 * there is one, so a role that reached an interview never reads as Shortlisted.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createDb, latestApplicationFor, roleStageSql, schema, type ApplicationStatus, type Db,
} from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import { ensureTestUser } from "./test-users";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test";

let db: Db;
let pool: pg.Pool;
let userId: string;
let jobId: string;

const TITLE = "Operations Director";
const COMPANY = "Acme";
const library = {
  name: "Test Candidate",
  contact: "London",
  profile: "Operations leader with delivery experience",
  entries: [{ id: "one", kind: "experience" as const, heading: "Director · Acme", details: "Led a team", confirmedResponsibilities: ["Led a team"] }],
};

beforeAll(async () => {
  const created = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(created.db);
  db = created.db;
  pool = created.pool;
}, 60_000);

afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  await db.execute(sql`truncate users, companies restart identity cascade`);
  userId = (await ensureTestUser(db, "role-stage@example.com")).id;
  const [company] = await db.insert(schema.companies).values({ name: COMPANY, domain: "acme.test", homepageUrl: "https://acme.test" }).returning();
  const [source] = await db.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://acme.test/jobs" }).returning();
  const [job] = await db.insert(schema.jobs).values({
    companyId: company!.id, sourceId: source!.id, externalKey: "id:1", title: TITLE,
    normalizedTitle: "operations director", url: "https://acme.test/jobs/1", location: "London", locations: ["London"],
  }).returning();
  jobId = job!.id;
  await db.insert(schema.userJobs).values({ userId, jobId, keywordMatched: true, locationOk: true, inTable: true });
});

/** The joins `roleStageSql` documents: the account's view, its active decision, its newest application. */
async function stage() {
  const latest = latestApplicationFor(userId);
  const [row] = await db
    .select({ stage: roleStageSql(latest, userId) })
    .from(schema.userJobs)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.userJobs.jobId))
    .leftJoin(schema.decisions, and(eq(schema.decisions.userId, userId), eq(schema.decisions.jobId, schema.jobs.id), eq(schema.decisions.superseded, false)))
    .leftJoin(latest, eq(latest.jobId, schema.jobs.id))
    .where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId)));
  return row!.stage;
}

const decide = (decision: "apply" | "skip") =>
  db.insert(schema.decisions).values({ userId, jobId, decision, jobTitle: TITLE, companyName: COMPANY });

const addCv = (over: Partial<typeof schema.cvDrafts.$inferInsert> = {}) =>
  db.insert(schema.cvDrafts).values({
    userId, jobId, jobTitle: TITLE, companyName: COMPANY, jobDescription: "Lead a team",
    libraryVersion: 1, librarySnapshot: library, model: "claude-sonnet-5", status: "ready", ...over,
  });

const record = (status: ApplicationStatus, over: Partial<typeof schema.applications.$inferInsert> = {}) =>
  db.insert(schema.applications).values({
    userId, jobId, jobTitle: TITLE, companyName: COMPANY, appliedOn: "2026-09-01", status,
    history: [{ status, at: "2026-09-01T09:00:00.000Z", notes: "" }], ...over,
  });

it("walks a role from matched to in process as the decision, the CV and the application arrive", async () => {
  expect(await stage()).toBe("matched");

  await decide("apply");
  expect(await stage()).toBe("shortlisted");

  // A CV being built for the role is the difference between Shortlisted and Applying.
  await addCv();
  expect(await stage()).toBe("applying");

  // Screening, interview and offer are one stage: the employer is considering it.
  await record("interview");
  expect(await stage()).toBe("in_process");
});

it("lets an application outrank the decision recorded behind it", async () => {
  await decide("skip");
  expect(await stage()).toBe("dismissed");

  // Skipped in the table, but an offer was accepted: the furthest anything got is what it shows.
  await record("accepted");
  expect(await stage()).toBe("accepted");
});

it("dismisses an archived view when nothing was ever submitted for it", async () => {
  await addCv();
  await db.update(schema.userJobs).set({ archivedAt: new Date("2026-09-10T09:00:00Z") })
    .where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId)));
  // The CV outlives the gate that narrowed; the role is still dismissed.
  expect(await stage()).toBe("dismissed");
});

it("takes the newest application for a role and leaves out rows with no posting", async () => {
  await record("rejected", { createdAt: new Date("2026-08-01T09:00:00Z"), appliedOn: "2026-08-01" });
  await record("offer", { createdAt: new Date("2026-09-01T09:00:00Z") });
  // An application recorded before the link existed, or one whose CV was deleted, joins to nothing.
  await record("applied", { jobId: null, createdAt: new Date("2026-09-15T09:00:00Z") });

  const rows = await db.select().from(latestApplicationFor(userId));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.jobId).toBe(jobId);
  expect(rows[0]!.status).toBe("offer");
  expect(await stage()).toBe("in_process");
});
