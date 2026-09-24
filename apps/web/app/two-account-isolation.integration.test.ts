/**
 * The catalogue is shared and the table is per account (CLAUDE.md). Two accounts following one
 * company see one shared posting, and each sees only its own decision, stage and application on
 * it: in the roles table's pages, in its blocks and in the export. And an account that names
 * another's row — an application, a CV, a role only the other follows — gets exactly the answer
 * it gets for an id that does not exist, so it cannot even learn that the row is there.
 *
 * The shared `jobs` row is where a join most easily loses its `userId`: every read of the table
 * joins decisions, the newest application and the view on it.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { schema, subscribeToCompany, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import { materialiseCv, type CvLibrary } from "@ava/core/cv";
import { signInTestUser } from "@/test/auth";
import { createTestDb } from "@/test/db";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createTestDb>["pool"];
let session: string | undefined;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session ? { value: session } : undefined), set: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers({ host: "ava.test", "x-forwarded-for": "198.51.100.46" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

import { fetchRolePage, fetchRoleRows, parseRolesFilters } from "@/lib/queries/jobs";
import { GET as exportCsv } from "./api/export.csv/route";
import { GET as applicationPdf } from "./api/applications/[id]/pdf/route";
import { GET as cvPdf } from "./api/cv/[id]/pdf/route";
import { recordApplication, setRoleStage, updateApplication, manageRoleCv } from "./actions/applications";
import { archiveRoles, decide, roleDetails } from "./actions/decisions";

const SECRET = "two-account-isolation-test-secret";
/** Ids no row has, of each kind the tests below name. */
const ABSENT = "00000000-0000-4000-8000-00000000dead";

const LIBRARY: CvLibrary = {
  name: "Alex Example", contact: "London", profile: "Operations lead",
  entries: [{ id: "job", kind: "experience", heading: "Director · Acme", details: "Led a team", confirmedResponsibilities: ["Led a team"] }],
};

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = SECRET;
}, 60_000);
afterAll(async () => { await pool?.end(); });

let a: { user: User; cookie: string };
let b: { user: User; cookie: string };
let shared: { id: string };
let onlyA: { id: string };
let application: { id: string };
let draft: { id: string };

beforeEach(async () => {
  session = undefined;
  await database.execute(sql`truncate users, companies, applications, cv_drafts, decisions, tasks, login_attempts restart identity cascade`);
  a = await signInTestUser(database, SECRET, "account-a@example.com", "member");
  b = await signInTestUser(database, SECRET, "account-b@example.com", "member");

  // Acme is followed by both accounts; Beta by A alone.
  const [acme, beta] = await database.insert(schema.companies).values([
    { name: "Acme", domain: "acme.example", homepageUrl: "https://acme.example" },
    { name: "Beta", domain: "beta.example", homepageUrl: "https://beta.example" },
  ]).returning();
  for (const [user, company] of [[a.user, acme], [b.user, acme], [a.user, beta]] as const) await subscribeToCompany(database, user.id, company!.id);
  const sources = await database.insert(schema.careerSources).values([
    { companyId: acme!.id, type: "html", url: "https://acme.example/jobs" },
    { companyId: beta!.id, type: "html", url: "https://beta.example/jobs" },
  ]).returning();
  const postings = await database.insert(schema.jobs).values([
    { companyId: acme!.id, sourceId: sources[0]!.id, externalKey: "1", title: "Operations Manager", normalizedTitle: "operations manager", url: "https://acme.example/jobs/1", location: "London" },
    { companyId: beta!.id, sourceId: sources[1]!.id, externalKey: "1", title: "Head of Operations", normalizedTitle: "head of operations", url: "https://beta.example/jobs/1", location: "London" },
  ]).returning({ id: schema.jobs.id });
  shared = postings[0]!;
  onlyA = postings[1]!;
  await database.insert(schema.userJobs).values([
    { userId: a.user.id, jobId: shared.id, inTable: true, keywordMatched: true, locationOk: true },
    { userId: b.user.id, jobId: shared.id, inTable: true, keywordMatched: true, locationOk: true },
    { userId: a.user.id, jobId: onlyA.id, inTable: true, keywordMatched: true, locationOk: true },
  ]);

  // A has shortlisted the shared role, built a CV for it and applied with that CV.
  const drafts = await database.insert(schema.cvDrafts).values({
    userId: a.user.id, jobId: shared.id, jobTitle: "Operations Manager", companyName: "Acme", jobDescription: "Run operations.",
    libraryVersion: 1, librarySnapshot: LIBRARY, model: "test", status: "ready",
    content: materialiseCv(LIBRARY, { summary: "Operations lead", sections: [{ entryId: "job", bullets: ["Led a team"] }], gaps: [] }),
  }).returning({ id: schema.cvDrafts.id });
  draft = drafts[0]!;
  const applied = await database.insert(schema.applications).values({
    userId: a.user.id, jobId: shared.id, cvId: draft.id, jobTitle: "Operations Manager", companyName: "Acme", appliedOn: "2026-09-01",
    status: "interview", pdfBase64: Buffer.from("%PDF-1.4 A's submission").toString("base64"),
    history: [{ status: "applied", at: "2026-09-01T09:00:00.000Z", notes: "", on: "2026-09-01" }],
  }).returning({ id: schema.applications.id });
  application = applied[0]!;
  session = a.cookie;
  expect(await decide(shared.id, "apply", "")).toEqual({ ok: true });
});

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const everything = parseRolesFilters({ decision: "all" });
const exportText = async () => (await exportCsv(new NextRequest("http://ava.test/api/export.csv?decision=all"))).text();

/** A's table as each of its read paths returns it. */
async function tableOfA() {
  session = a.cookie;
  return {
    rows: await fetchRoleRows(a.user.id, everything, false),
    page: await fetchRolePage(a.user.id, everything, false, null, 1),
    csv: await exportText(),
  };
}

it("shows each follower of a shared posting only their own decision and stage, in the table, its pages and the export", async () => {
  const before = await tableOfA();
  const mine = before.rows.find((row) => row.job.id === shared.id)!;
  expect(mine).toMatchObject({ decision: { decision: "apply" }, applicationStatus: "interview" });

  // B passes on the same posting with a reason and records a rejection against it.
  session = b.cookie;
  expect(await decide(shared.id, "skip", "Too far from home")).toEqual({ ok: true });
  expect(await setRoleStage(shared.id, { ok: true }, form({ status: "rejected", appliedOn: "2026-09-02", notes: "B's note" }))).toEqual({ ok: true });
  const theirs = (await fetchRoleRows(b.user.id, everything, false)).find((row) => row.job.id === shared.id)!;
  expect(theirs).toMatchObject({ decision: { decision: "skip", reason: "Too far from home" }, applicationStatus: "rejected" });

  // Nothing B did reaches any of A's reads, and A's CSV carries none of B's words.
  expect(await tableOfA()).toEqual(before);
  expect(before.csv).not.toContain("Too far from home");
  expect(before.page.total).toBe(2);
  // And B's table is B's alone: the role only A follows is not in it.
  expect((await fetchRoleRows(b.user.id, everything, false)).map((row) => row.job.id)).toEqual([shared.id]);
});

it("answers another account's application PDF, CV PDF and application edits exactly as it answers ids that do not exist", async () => {
  // A's own downloads work, so the ids below are real.
  session = a.cookie;
  expect((await applicationPdf(new Request("http://ava.test/"), { params: Promise.resolve({ id: application.id }) })).status).toBe(200);
  expect((await cvPdf(new Request(`http://ava.test/api/cv/${draft.id}/pdf?preview=1`), { params: Promise.resolve({ id: draft.id }) })).status).toBe(200);
  const rowsOfA = async () => ({
    application: await database.select().from(schema.applications).where(eq(schema.applications.userId, a.user.id)),
    drafts: await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.userId, a.user.id)),
    decisions: await database.select().from(schema.decisions).where(eq(schema.decisions.userId, a.user.id)),
    views: await database.select().from(schema.userJobs).where(eq(schema.userJobs.userId, a.user.id)),
  });
  const untouched = await rowsOfA();

  session = b.cookie;
  /** Each of B's attempts, once with A's id and once with an id nobody has: the answers must be the same. */
  const both = async (attempt: (id: string) => Promise<unknown>, real: string) => [await attempt(real), await attempt(ABSENT)];
  const answer = async (response: Response) => ({ status: response.status, body: await response.text() });

  const [pdfOfA, pdfOfNobody] = await both(async (id) => answer(await applicationPdf(new Request("http://ava.test/"), { params: Promise.resolve({ id }) })), application.id);
  expect(pdfOfA).toEqual({ status: 404, body: "Not found" });
  expect(pdfOfA).toEqual(pdfOfNobody);

  const [cvOfA, cvOfNobody] = await both(async (id) => answer(await cvPdf(new Request(`http://ava.test/api/cv/${id}/pdf?preview=1`), { params: Promise.resolve({ id }) })), draft.id);
  expect(cvOfA).toEqual({ status: 404, body: "Not found" });
  expect(cvOfA).toEqual(cvOfNobody);

  const [updated, updatedNothing] = await both((id) => updateApplication(id, { ok: true }, form({ status: "rejected", notes: "B was here" })), application.id);
  expect(updated).toEqual({ ok: false, error: "Application not found." });
  expect(updated).toEqual(updatedNothing);

  const [recorded, recordedNothing] = await both((id) => recordApplication(id, { ok: true }, form({ appliedOn: "2026-09-03" })), draft.id);
  expect(recorded).toEqual({ ok: false, error: "Choose a completed, saved CV." });
  expect(recorded).toEqual(recordedNothing);

  // The role only A follows is, to B, a role that does not exist, whatever B asks of it.
  const [staged, stagedNothing] = await both((id) => setRoleStage(id, { ok: true }, form({ status: "applied", appliedOn: "2026-09-03" })), onlyA.id);
  expect(staged).toEqual({ ok: false, error: "Role not found." });
  expect(staged).toEqual(stagedNothing);
  const [decided, decidedNothing] = await both((id) => decide(id, "skip", "Not for me"), onlyA.id);
  expect(decided).toEqual({ ok: false, error: "Role not found." });
  expect(decided).toEqual(decidedNothing);
  const [archived, archivedNothing] = await both((id) => archiveRoles([id], true), onlyA.id);
  expect(archived).toMatchObject({ ok: false });
  expect(archived).toEqual(archivedNothing);
  const [details, detailsOfNothing] = await both((id) => roleDetails(id), onlyA.id);
  expect(details).toMatchObject({ ok: false });
  expect(details).toEqual(detailsOfNothing);
  const [managed, managedNothing] = await both((id) => manageRoleCv(shared.id, id, "delete"), draft.id);
  expect(managed).toEqual(managedNothing);

  // None of it wrote anything of A's, or anything of B's against A's rows.
  expect(await rowsOfA()).toEqual(untouched);
  expect(await database.select().from(schema.applications).where(and(eq(schema.applications.userId, b.user.id)))).toEqual([]);
  expect(await database.select().from(schema.decisions).where(eq(schema.decisions.userId, b.user.id))).toEqual([]);
});
