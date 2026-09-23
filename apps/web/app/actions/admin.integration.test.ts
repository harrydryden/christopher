/**
 * The administrator's catalogue actions, against the database.
 *
 * Removing a shared source used to delete it, and the foreign keys cascaded that to its scans,
 * every posting it had seen and every follower's view of them. It now retires the source: nothing
 * scans it, everything it observed stays, and only the views nobody has worked on are archived.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, subscribeToCompany, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import { signInTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let admin: { user: User; cookie: string };
let member: { user: User; cookie: string };
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (session ? { value: session } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

import { removeCatalogueSource, saveCatalogueCompany } from "./admin";

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_b");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "integration-test-secret";
}, 120_000);
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate companies, tasks, decisions, applications, users restart identity cascade`);
  admin = await signInTestUser(database, process.env.SESSION_SECRET!, "catalogue-admin@example.com", "admin");
  member = await signInTestUser(database, process.env.SESSION_SECRET!, "follower@example.com", "member");
  session = admin.cookie;
});

/** One source with a scan and three open roles, seen by both accounts; some views carry work. */
async function fixture() {
  const [company] = await database.insert(schema.companies)
    .values({ name: "Acme", domain: "acme.example", homepageUrl: "https://acme.example" }).returning();
  const [source] = await database.insert(schema.careerSources)
    .values({ companyId: company!.id, type: "greenhouse", url: "https://boards.greenhouse.io/acme", atsSlug: "acme" }).returning();
  await database.insert(schema.scans).values({ sourceId: source!.id, status: "ok", postingsFound: 3 });
  const jobs = await database.insert(schema.jobs).values(["one", "two", "three"].map(key => ({
    companyId: company!.id, sourceId: source!.id, externalKey: key, title: `Operations ${key}`, normalizedTitle: `operations ${key}`,
    url: `https://boards.greenhouse.io/acme/jobs/${key}`,
  }))).returning();
  const [one, two, three] = jobs;
  for (const account of [admin.user, member.user]) {
    await subscribeToCompany(database, account.id, company!.id);
    await database.insert(schema.userJobs).values(jobs.map(job => ({ userId: account.id, jobId: job.id, inTable: true })));
  }
  // The administrator shortlisted one role; the member is applying for another.
  const [decision] = await database.insert(schema.decisions)
    .values({ userId: admin.user.id, jobId: one!.id, decision: "apply", jobTitle: one!.title, companyName: "Acme" }).returning();
  const [application] = await database.insert(schema.applications).values({
    userId: member.user.id, jobId: two!.id, jobTitle: two!.title, companyName: "Acme", appliedOn: "2026-09-01", status: "applied",
    history: [{ status: "applied", at: "2026-09-01T09:00:00.000Z", notes: "" }],
  }).returning();
  return { company: company!, source: source!, one: one!, two: two!, three: three!, decision: decision!, application: application! };
}

const view = async (userId: string, jobId: string) =>
  (await database.select().from(schema.userJobs).where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId))))[0];

it("retires a source instead of deleting what every follower observed through it", async () => {
  const { source, one, two, three, decision, application } = await fixture();

  await removeCatalogueSource(source.id);

  const [retired] = await database.select().from(schema.careerSources).where(eq(schema.careerSources.id, source.id));
  expect(retired!.status).toBe("disabled");
  // The scan history and every posting stay. The roles close, but not as a scan closes them: no
  // listing was read, so each is closed as of the last time a scan saw it, with an event that
  // says the source was retired (a role left open on a source nobody scans would read as live
  // for ever, and a company followed again would admit months-old "open" roles).
  expect(await database.select().from(schema.scans)).toHaveLength(1);
  const jobs = await database.select().from(schema.jobs);
  expect(jobs.map(job => job.status)).toEqual(["closed", "closed", "closed"]);
  for (const job of jobs) expect(job.closedAt?.getTime()).toBe(job.lastSeenAt?.getTime());
  const closures = await database.select().from(schema.jobEvents).where(eq(schema.jobEvents.type, "closed"));
  expect(closures).toHaveLength(3);
  expect(closures.every(event => (event.payload as { reason?: string }).reason === "source_retired")).toBe(true);
  expect(await database.select().from(schema.userJobs)).toHaveLength(6);
  // Work a person did on a role keeps it where it was: the shortlist, the application.
  expect((await view(admin.user.id, one.id))!.archivedAt).toBeNull();
  expect((await view(member.user.id, two.id))!.archivedAt).toBeNull();
  expect((await database.select().from(schema.decisions).where(eq(schema.decisions.id, decision.id)))[0]!.jobId).toBe(one.id);
  expect((await database.select().from(schema.applications).where(eq(schema.applications.id, application.id)))[0]!.jobId).toBe(two.id);
  // Everything else is put away, with an event that says why.
  for (const [userId, jobId] of [[admin.user.id, two.id], [admin.user.id, three.id], [member.user.id, one.id], [member.user.id, three.id]] as const) {
    expect((await view(userId, jobId))!.archivedAt).toBeInstanceOf(Date);
  }
  const events = await database.select().from(schema.jobEvents).where(eq(schema.jobEvents.type, "updated"));
  expect(events).toHaveLength(4);
  expect(events[0]!.payload).toMatchObject({ action: "archived", actor: "system", cause: "source_retired" });
});

it("leaves the catalogue alone for a member", async () => {
  const { source } = await fixture();
  session = member.cookie;
  await expect(removeCatalogueSource(source.id)).rejects.toThrow("Forbidden");
  const [untouched] = await database.select().from(schema.careerSources).where(eq(schema.careerSources.id, source.id));
  expect(untouched!.status).toBe("active");
  expect((await database.select().from(schema.userJobs)).every(row => row.archivedAt === null)).toBe(true);
});

it("refuses a main website the worker will never fetch", async () => {
  const { company } = await fixture();
  const form = new FormData();
  form.set("name", "Acme");
  form.set("homepageUrl", "http://10.1.2.3/");
  expect(await saveCatalogueCompany(company.id, { ok: true }, form)).toEqual({ ok: false, error: "10.1.2.3 is a private or local network address." });
  const [unchanged] = await database.select().from(schema.companies).where(eq(schema.companies.id, company.id));
  expect(unchanged!.homepageUrl).toBe("https://acme.example");
});
