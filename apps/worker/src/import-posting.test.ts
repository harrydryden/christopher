/**
 * A role a follower adds by pasting its URL.
 *
 * The posting joins the shared catalogue like any other, so every follower's gate is offered it;
 * what is particular here is the asker. They named this role, so it goes into their table whether
 * or not their own keywords would have admitted it — and the verdict is recorded beside it, so the
 * interface can say as much. Everything a person has to act on (a page that is not a posting, a
 * company with no source) finishes the task `done` with a sentence; only a transport failure
 * throws, because only a transport failure is worth retrying.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createDb, enqueueTask, schema, subscribeToCompany, type Db, type User } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { dedupeKeyFor, normalisePostingUrl, sha1 } from "@ava/core";
import { and, eq, sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { handlers } from "./handlers";
import { handleImportPosting } from "./handlers/import-posting";
import { TaskQueue } from "./queue";
import { ensureTestUser } from "./test-users";
import { startTestServer, type TestServer } from "./test-server";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";
const HOSTS = ["www.pasted.test", "pasted.test"];

const STAFF_ENGINEER = "https://www.pasted.test/jobs/staff-engineer";
const THIN = "https://www.pasted.test/jobs/thin";
const NOT_A_POSTING = "https://www.pasted.test/jobs";

const DESCRIPTION = "You will own the platform team's roadmap, run the on-call rotation and work with operations on capacity. ".repeat(6);

function jsonLdPage(title: string, url: string, description: string): string {
  return `<!doctype html><html><head><title>${title}</title>
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title,
      url,
      description: `<p>${description}</p>`,
      datePosted: "2026-09-10",
      employmentType: "FULL_TIME",
      jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "London", addressCountry: "UK" } },
    })}</script></head><body><h1>${title}</h1><p>${description}</p></body></html>`;
}

let server: TestServer;
let deps: WorkerDeps;
let queue: TaskQueue;
let db: Db;
let now = new Date("2026-09-19T09:00:00Z");
let importer: User;
let matching: User;
let missing: User;
let company: typeof schema.companies.$inferSelect;

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();

  server = await startTestServer({
    "www.pasted.test": {
      "/robots.txt": { body: "User-agent: *\nAllow: /\n", contentType: "text/plain" },
      "/jobs/staff-engineer": { body: jsonLdPage("Staff Engineer, Platform", STAFF_ENGINEER, DESCRIPTION) },
      // A posting whose page gives up a title and almost nothing else.
      "/jobs/thin": { body: `<!doctype html><html><head><title>Engineer, Data | Pasted Ltd</title>
        <meta property="og:site_name" content="Pasted Ltd"></head><body><h1>Engineer, Data</h1><p>Apply here.</p></body></html>` },
      // A listing, not a role: nothing on it names a job, so there is no title to take.
      "/jobs": { body: "<!doctype html><html><head></head><body><ul><li>roles</li></ul></body></html>" },
    },
  }, HOSTS);

  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AVA_HOST_MAP = JSON.stringify(server.hostMap);
  process.env.AVA_DISABLE_BROWSER = "1";
  delete process.env.ANTHROPIC_API_KEY;
  deps = await createDeps(readEnv(), { now: () => now, settingsTtlMs: 0 });
  db = deps.db;
  queue = new TaskQueue(deps, handlers, { concurrency: 1, workerId: "test" });
}, 60_000);

afterAll(async () => {
  await deps?.close();
  await server?.close();
});

beforeEach(async () => {
  await db.execute(sql`truncate users, companies, company_subscriptions, career_sources, jobs, job_events, user_jobs, tasks, settings, user_settings, resource_leases restart identity cascade`);
  now = new Date("2026-09-19T09:00:00Z");
  importer = await ensureTestUser(db, "importer@example.com");
  matching = await ensureTestUser(db, "matching@example.com", "member");
  missing = await ensureTestUser(db, "missing@example.com", "member");
  // The asker's own keywords miss this role; the second follower's match; the third's do not.
  await setGate(importer, ["operations"]);
  await setGate(matching, ["engineer"]);
  await setGate(missing, ["marketing"]);
  company = await addCompany();
});

async function setGate(user: User, includeKeywords: string[]) {
  const value = { includeKeywords, excludeKeywords: [], matchFields: ["title"], locationTerms: [], includeRemote: true };
  await db.insert(schema.userSettings).values({ userId: user.id, key: "gate", value })
    .onConflictDoUpdate({ target: [schema.userSettings.userId, schema.userSettings.key], set: { value } });
  deps.invalidateSettings();
}

async function addCompany({ withSource = true } = {}) {
  const [row] = await db.insert(schema.companies).values({ name: "Pasted Ltd", domain: "pasted.test", homepageUrl: "https://www.pasted.test/" }).returning();
  for (const user of [importer, matching, missing]) await subscribeToCompany(db, user.id, row!.id);
  if (withSource) await db.insert(schema.careerSources).values({ companyId: row!.id, type: "html", url: "https://www.pasted.test/jobs", status: "active" });
  return row!;
}

const importTask = (url: string, user: User = importer) => ({
  id: "00000000-0000-0000-0000-00000000000a",
  type: "import_posting",
  payload: { userId: user.id, companyId: company.id, url },
  attempts: 1,
} as never);

const viewsFor = (user: User) => db.select().from(schema.userJobs).where(eq(schema.userJobs.userId, user.id));
const tasksOfType = (type: string) => db.select().from(schema.tasks).where(eq(schema.tasks.type, type as "score_job"));

it("stores the posting once for everyone and puts it in the asker's table whatever their gate says", async () => {
  const result = await handleImportPosting(importTask(STAFF_ENGINEER), deps) as {
    ok: true; jobId: string; title: string; existing: boolean; gate: Record<string, unknown>;
  };
  expect(result).toMatchObject({
    ok: true,
    existing: false,
    title: "Staff Engineer, Platform",
    // The verdict is honest: their keywords do not match, which is what the interface tells them.
    gate: { inTable: false, keywordMatched: false, locationOk: true, excluded: false, keywordTerms: [] },
  });

  const [job] = await db.select().from(schema.jobs);
  expect(job).toMatchObject({
    id: result.jobId,
    origin: "user",
    addedBy: importer.id,
    externalKey: `url:${sha1(normalisePostingUrl(STAFF_ENGINEER))}`,
    url: STAFF_ENGINEER,
    title: "Staff Engineer, Platform",
    location: "London, UK",
    status: "open",
    seeded: false,
    descriptionSource: "direct",
  });
  expect(job!.descriptionText).toContain("own the platform team's roadmap");
  expect(job!.postedAt?.toISOString().slice(0, 10)).toBe("2026-09-10");
  const [source] = await db.select().from(schema.careerSources);
  expect(job!.sourceId).toBe(source!.id);

  const events = await db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, job!.id));
  expect(events.map(e => [e.type, e.payload])).toEqual([["discovered", { method: "user" }]]);

  // The asker's view: in their table, with the gate's own reading recorded beside it.
  const [mine] = await viewsFor(importer);
  expect(mine).toMatchObject({ jobId: job!.id, inTable: true, keywordMatched: false, excluded: false, locationOk: true, nearMiss: false, seeded: false });

  // Everyone else meets it through their own gate, and nothing is forced into anybody's table.
  expect((await viewsFor(matching)).map(v => [v.jobId, v.inTable])).toEqual([[job!.id, true]]);
  expect(await viewsFor(missing)).toHaveLength(0);

  const scoring = await tasksOfType("score_job");
  expect(scoring.map(t => [(t.payload as { userId: string }).userId, t.priority])).toContainEqual([importer.id, 1]);
  // The page carried its own description, so nothing has to go and read one.
  expect(await tasksOfType("fetch_description")).toHaveLength(0);
});

it("recognises the same link a second time, tracking parameters and all", async () => {
  const first = await handleImportPosting(importTask(STAFF_ENGINEER), deps) as { jobId: string };
  const again = await handleImportPosting(importTask(`${STAFF_ENGINEER}?utm_source=newsletter`), deps) as {
    ok: true; jobId: string; existing: boolean; gate: { keywordMatched: boolean };
  };
  expect(again).toMatchObject({ ok: true, existing: true, jobId: first.jobId });
  expect(again.gate.keywordMatched).toBe(false);
  expect(await db.select().from(schema.jobs)).toHaveLength(1);
  expect(await viewsFor(importer)).toHaveLength(1);
  // A second person pasting a link the catalogue already has gets their own view of it.
  await setGate(missing, ["marketing"]);
  const third = await handleImportPosting(importTask(STAFF_ENGINEER, missing), deps) as { ok: true; existing: boolean };
  expect(third.existing).toBe(true);
  expect((await viewsFor(missing)).map(v => [v.jobId, v.inTable])).toEqual([[first.jobId, true]]);
});

it("queues a proper description read when the page gave almost none", async () => {
  const result = await handleImportPosting(importTask(THIN), deps) as { ok: true; jobId: string; title: string };
  expect(result.title).toBe("Engineer, Data");
  const queued = await tasksOfType("fetch_description");
  expect(queued.map(t => [(t.payload as { jobId: string }).jobId, t.dedupeKey]))
    .toEqual([[result.jobId, dedupeKeyFor("fetch_description", { jobId: result.jobId })]]);
});

it("tells the person a page is not a posting, and finishes the task rather than retrying it", async () => {
  await enqueueTask(db, "import_posting", { userId: importer.id, companyId: company.id, url: NOT_A_POSTING }, {
    dedupeKey: dedupeKeyFor("import_posting", { userId: importer.id, companyId: company.id, url: NOT_A_POSTING }), priority: 1,
  });
  await queue.drain();

  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.type, "import_posting"));
  expect(task!.status).toBe("done");
  expect(task!.attempts).toBe(1);
  expect(task!.result).toMatchObject({ ok: false });
  expect((task!.result as { reason: string }).reason).toContain("does not look like a job posting");
  expect(await db.select().from(schema.jobs)).toHaveLength(0);
});

it("asks for a careers source before it will store anything", async () => {
  await db.delete(schema.careerSources).where(eq(schema.careerSources.companyId, company.id));
  expect(await handleImportPosting(importTask(STAFF_ENGINEER), deps))
    .toEqual({ ok: false, reason: "This company has no careers source yet. Add its careers URL first." });
  expect(await db.select().from(schema.jobs)).toHaveLength(0);
});

it("refuses a company the person no longer follows", async () => {
  await db.update(schema.companySubscriptions).set({ status: "archived" })
    .where(and(eq(schema.companySubscriptions.userId, importer.id), eq(schema.companySubscriptions.companyId, company.id)));
  expect(await handleImportPosting(importTask(STAFF_ENGINEER), deps))
    .toEqual({ ok: false, reason: "You no longer follow this company." });
});

it("tells the person when the link itself is dead, but retries a server that is merely down", async () => {
  const gone = "https://www.pasted.test/jobs/was-here";
  const dead = await handleImportPosting(importTask(gone), deps) as { ok: false; reason: string };
  expect(dead.ok).toBe(false);
  expect(dead.reason).toContain("answered HTTP 404");
  expect(await db.select().from(schema.jobs)).toHaveLength(0);
});

it("throws when the site cannot be reached, so the queue retries with its backoff", async () => {
  const unreachable = "https://elsewhere.test/jobs/1";
  await expect(handleImportPosting(importTask(unreachable), deps))
    .rejects.toThrow("Could not fetch elsewhere.test: network error");
  expect(await db.select().from(schema.jobs)).toHaveLength(0);
});
