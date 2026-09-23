/**
 * A role somebody added by URL, meeting the daily scan.
 *
 * Two rules, and both are about not lying to the person. A posting that was never in a listing
 * cannot be missing from one, so no number of successful scans may close it. And when the listing
 * does finally carry it, it is the same vacancy: the scan adopts the row it already has rather
 * than storing a second one beside it, after which the ordinary two-miss rule applies.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createDb, schema, subscribeToCompany, type Db, type User } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { normalisePostingUrl, sha1 } from "@ava/core";
import { eq, sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { _scanSourceForTests } from "./handlers/scan";
import { ensureTestUser } from "./test-users";
import { startTestServer, type RouteTable, type TestServer } from "./test-server";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";
const HOSTS = ["boards-api.greenhouse.io", "job-boards.greenhouse.io"];

/** The role the scan finds for itself, which is here to show the ordinary rules still run. */
const LISTED = {
  id: 4001001,
  title: "Operations Manager",
  first_published: "2026-09-02T09:00:00Z",
  absolute_url: "https://job-boards.greenhouse.io/pasted/jobs/4001001",
  location: { name: "London, UK" },
};

/** The role a person pasted, as the board eventually lists it — with a referral marker on the URL. */
const PASTED_URL = "https://job-boards.greenhouse.io/pasted/jobs/5500001";
const LISTED_PASTED = {
  id: 5500001,
  title: "Staff Engineer, Platform",
  first_published: "2026-09-11T09:00:00Z",
  absolute_url: `${PASTED_URL}?gh_src=newsletter`,
  location: { name: "London, UK" },
};

let server: TestServer;
let deps: WorkerDeps;
let db: Db;
let now = new Date("2026-09-19T09:00:00Z");
let user: User;
let company: typeof schema.companies.$inferSelect;
let source: typeof schema.careerSources.$inferSelect;

function board(jobs: Array<Record<string, unknown>>): RouteTable {
  return {
    "boards-api.greenhouse.io": {
      "/robots.txt": { body: "User-agent: *\nDisallow: /\n", contentType: "text/plain" },
      "/v1/boards/pasted/jobs": { body: { jobs, meta: { total: jobs.length } } },
    },
    "job-boards.greenhouse.io": {},
  };
}

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();

  server = await startTestServer(board([LISTED]), HOSTS);
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AVA_HOST_MAP = JSON.stringify(server.hostMap);
  process.env.AVA_DISABLE_BROWSER = "1";
  delete process.env.ANTHROPIC_API_KEY;
  deps = await createDeps(readEnv(), { now: () => now, settingsTtlMs: 0 });
  db = deps.db;
}, 60_000);

afterAll(async () => {
  await deps?.close();
  await server?.close();
});

beforeEach(async () => {
  await db.execute(sql`truncate users, companies, company_subscriptions, career_sources, scans, jobs, job_events, user_jobs, tasks, settings, user_settings, resource_leases restart identity cascade`);
  now = new Date("2026-09-19T09:00:00Z");
  server.setRoutes(board([LISTED]));
  user = await ensureTestUser(db, "paster@example.com");
  // Their gate would never have admitted the role they pasted: that is the point of pasting it.
  const gate = { includeKeywords: ["operations"], excludeKeywords: [], matchFields: ["title"], locationTerms: [], includeRemote: true };
  await db.insert(schema.userSettings).values({ userId: user.id, key: "gate", value: gate })
    .onConflictDoUpdate({ target: [schema.userSettings.userId, schema.userSettings.key], set: { value: gate } });
  deps.invalidateSettings();

  const [row] = await db.insert(schema.companies).values({ name: "Pasted Ltd", domain: "pasted.test", homepageUrl: "https://www.pasted.test/" }).returning();
  company = row!;
  await subscribeToCompany(db, user.id, company.id);
  const [created] = await db.insert(schema.careerSources).values({
    companyId: company.id, type: "greenhouse", url: "https://job-boards.greenhouse.io/pasted",
    apiUrl: "https://boards-api.greenhouse.io/v1/boards/pasted/jobs", atsSlug: "pasted", status: "active",
  }).returning();
  source = created!;
});

/** The row the `import_posting` handler writes, with this account's view of it. */
async function pastedRole() {
  const [job] = await db.insert(schema.jobs).values({
    companyId: company.id,
    sourceId: source.id,
    externalKey: `url:${sha1(normalisePostingUrl(PASTED_URL))}`,
    title: "Staff Engineer, Platform",
    normalizedTitle: "staff engineer, platform",
    url: PASTED_URL,
    location: "London, UK",
    locations: ["London, UK"],
    origin: "user",
    addedBy: user.id,
    firstSeenAt: now,
    lastSeenAt: now,
    descriptionText: "Own the platform.",
  }).returning();
  await db.insert(schema.userJobs).values({
    userId: user.id, jobId: job!.id, keywordMatched: false, keywordTerms: [],
    excluded: false, locationOk: true, inTable: true, seeded: false, createdAt: now, updatedAt: now,
  });
  return job!;
}

const scan = async () => {
  const outcome = await _scanSourceForTests(deps, company, source, await deps.settings(), null);
  now = new Date(now.getTime() + 86_400_000);
  return outcome;
};

const read = async (id: string) => (await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1))[0]!;
const eventsFor = (id: string) => db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, id));

it("never counts a pasted role missing, however many successful scans do not list it", async () => {
  const pasted = await pastedRole();

  for (let i = 0; i < 2; i++) expect((await scan()).status).toBe("ok");

  const after = await read(pasted.id);
  expect(after).toMatchObject({ status: "open", missingScans: 0, origin: "user", closedAt: null });
  // Two successful scans is exactly what closes an ordinary role; this one was never in a listing.
  expect((await eventsFor(pasted.id)).map(e => e.type)).not.toContain("closed");
  // The listing's own role is stored beside it, and the person's view of the pasted one stands.
  expect(await db.select().from(schema.jobs)).toHaveLength(2);
  const [view] = await db.select().from(schema.userJobs).where(eq(schema.userJobs.jobId, pasted.id));
  expect(view!.inTable).toBe(true);
});

it("adopts the pasted role once the listing carries it, rather than storing it twice", async () => {
  const pasted = await pastedRole();
  await scan();

  server.setRoutes(board([LISTED, LISTED_PASTED]));
  const outcome = await scan();
  // Nothing new: the board's "new" role is the one that was already here.
  expect(outcome.newCount).toBe(0);
  expect(await db.select().from(schema.jobs)).toHaveLength(2);

  const adopted = await read(pasted.id);
  expect(adopted).toMatchObject({
    id: pasted.id,
    origin: "scan",
    externalKey: "id:5500001",
    url: LISTED_PASTED.absolute_url,
    status: "open",
    missingScans: 0,
    // The person who found it keeps the credit.
    addedBy: user.id,
  });
  expect(adopted.postedAt?.toISOString()).toBe(new Date(LISTED_PASTED.first_published).toISOString());
  const adoptedEvents = (await eventsFor(pasted.id)).filter(e => e.type === "updated");
  expect(adoptedEvents.map(e => e.payload)).toContainEqual({ action: "adopted", method: "api" });
  // A role they added stays theirs: the scan's gate refresh does not take it out of their table.
  const [view] = await db.select().from(schema.userJobs).where(eq(schema.userJobs.jobId, pasted.id));
  expect(view!.inTable).toBe(true);
});

it("closes an adopted role by the ordinary two-miss rule once the board drops it", async () => {
  const pasted = await pastedRole();
  server.setRoutes(board([LISTED, LISTED_PASTED]));
  await scan();
  expect((await read(pasted.id)).origin).toBe("scan");

  server.setRoutes(board([LISTED]));
  await scan();
  expect(await read(pasted.id)).toMatchObject({ status: "open", missingScans: 1 });
  await scan();
  const closed = await read(pasted.id);
  expect(closed.status).toBe("closed");
  expect(closed.closedAt).toBeInstanceOf(Date);
  expect((await eventsFor(pasted.id)).map(e => e.type)).toContain("closed");
});
