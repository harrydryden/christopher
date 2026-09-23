/**
 * End-to-end test over a real Postgres database and a fake company website.
 * Covers the whole path the spec describes: add a homepage URL, discover the careers source,
 * scan it, apply the keyword and location gate, then detect a removed role two scans later.
 *
 * Requires a database: set TEST_DATABASE_URL (defaults to the local ava_test database).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {createDb, readCompanyLogo, retireSourceRoles, schema, enqueueTask, reevaluateGate, subscribeToCompany, type Db, type User} from "@ava/db";
import { ensureTestUser } from "./test-users";
import { runMigrations } from "@ava/db/migrate";
import { ats, dedupeKeyFor, displayStatus, liveFor, priorityFor, sha1 } from "@ava/core";
import { and, desc, eq, sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { handlers } from "./handlers";
import { _scanSourceForTests, handleScanCompany } from "./handlers/scan";
import { handleSuggestFromScans } from "./handlers/suggest-from-scans";
import { handleScoreJob, handleTagReason } from "./handlers/learning";
import { anchoredInPage, handleFetchDescription } from "./handlers/description";
import { handleRunDaily, finaliseScanRuns } from "./handlers/daily";
import { TaskQueue } from "./queue";
import { startTestServer, type RouteTable, type TestServer } from "./test-server";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";
const HOSTS = ["www.acme.example", "acme.example", "boards-api.greenhouse.io", "job-boards.greenhouse.io", "www.orbital.example", "orbital.example", "api.smartrecruiters.com", "pager.example", "acme.wd1.myworkdayjobs.com"];

/** A real PNG, because the logo capture sniffs the bytes and refuses anything that is not one. */
function pngBytes(length = 400): Buffer {
  const bytes = Buffer.alloc(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let i = 8; i < length; i++) bytes[i] = i % 251;
  return bytes;
}

/** An Anthropic-style site: homepage -> careers landing -> listing backed by a Greenhouse board. */
function acmeRoutes(): RouteTable[string] {
  return {
    "/favicon.png": { body: pngBytes(), contentType: "image/png" },
    "/": {
      body: `<!doctype html><html><head><title>Acme Robotics | Building the future</title>
        <meta property="og:site_name" content="Acme Robotics"><link rel="icon" href="/favicon.png"></head>
        <body><header><nav><a href="/">Home</a><a href="/product">Product</a><a href="/research">Research</a>
        <a href="/blog">Blog</a><a href="/careers">Careers</a></nav></header>
        <main><h1>Acme Robotics</h1><p>We build robots for warehouses.</p></main></body></html>`,
    },
    "/careers": {
      body: `<!doctype html><html><head><title>Careers | Acme Robotics</title></head><body>
        <h1>Join us</h1><p>We are a team of engineers and operators.</p>
        <a href="/careers/jobs">See open roles</a></body></html>`,
    },
    "/careers/jobs": {
      body: `<!doctype html><html><head><title>Open roles | Acme Robotics</title></head><body>
        <ul class="roles">
          <li><a href="https://job-boards.greenhouse.io/acme/jobs/4001001">Operations Manager</a><span>London, UK</span></li>
          <li><a href="https://job-boards.greenhouse.io/acme/jobs/4001003">Software Engineer</a><span>London, UK</span></li>
        </ul></body></html>`,
    },
    "/robots.txt": { body: "User-agent: *\nAllow: /\n", contentType: "text/plain" },
  };
}

/**
 * The board API as the adapter now uses it: the listing carries no descriptions (the fixture
 * strips `content` from it the way `?content=true` being absent does), and each role's text is
 * served from its own detail endpoint.
 */
function greenhouseRoutes(jobs: Array<Record<string, unknown>>): RouteTable[string] {
  const listing = jobs.map(({ content: _content, ...rest }) => rest);
  const details = Object.fromEntries(jobs.map((job) => [`/v1/boards/acme/jobs/${String(job.id)}`, { body: job }]));
  return {
    ...details,
    "/v1/boards/acme/jobs": { body: { jobs: listing, meta: { total: listing.length } } },
    "/v1/boards/acme": { body: { name: "Acme Robotics", content: "About Acme" } },
  };
}

/**
 * A SmartRecruiters board in two sizes. `capped` is larger than the ten pages of 100 the adapter
 * can read, and the roles the account already follows sit past that cap: a scan that called such a
 * listing complete would close all three after two runs.
 */
function smartRecruitersRoutes(mode: "small" | "capped"): RouteTable[string] {
  const posting = (id: string, name: string) => ({ id, name, location: { city: "London", country: "UK", fullLocation: "London, UK" }, releasedDate: "2026-09-01T00:00:00Z" });
  const followed = [posting("ops-1", "Operations Manager"), posting("ops-2", "Operations Analyst"), posting("ops-3", "Operations Lead")];
  return {
    "/robots.txt": { body: "User-agent: *\nAllow: /\n", contentType: "text/plain" },
    "/v1/companies/orbital/postings": (req) => {
      const offset = Number(new URL(req.url ?? "/", "https://api.smartrecruiters.com").searchParams.get("offset") ?? "0");
      if (mode === "small") return { body: { offset, limit: 100, totalFound: followed.length, content: offset === 0 ? followed : [] } };
      const content = Array.from({ length: 100 }, (_, i) => posting(`filler-${offset + i}`, `Systems Technician ${offset + i}`));
      return { body: { offset, limit: 100, totalFound: 25_000, content } };
    },
  };
}

const JOB_OPERATIONS_MANAGER = {
  id: 4001001,
  title: "Operations Manager",
  updated_at: "2026-08-30T09:00:00Z",
  first_published: "2026-09-02T09:00:00Z",
  absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4001001",
  location: { name: "London, UK" },
  departments: [{ name: "Operations" }],
  offices: [{ name: "London" }],
  content: "&lt;p&gt;Own operations for our London site.&lt;/p&gt;",
};
const JOB_ENGINEER = {
  id: 4001003,
  title: "Software Engineer, Platform",
  updated_at: "2026-08-15T09:00:00Z",
  first_published: "2026-06-10T09:00:00Z",
  absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4001003",
  location: { name: "London, UK" },
  departments: [{ name: "Engineering" }],
  content: "&lt;p&gt;Build the platform.&lt;/p&gt;",
};
const JOB_OPS_NEW_YORK = {
  id: 4001004,
  title: "Head of Business Operations",
  updated_at: "2026-09-01T09:00:00Z",
  first_published: "2026-09-01T09:00:00Z",
  absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4001004",
  location: { name: "New York, NY" },
  departments: [{ name: "Operations" }],
  content: "&lt;p&gt;Lead business operations in New York.&lt;/p&gt;",
};
const JOB_OPS_REMOTE_US = {
  id: 4001005,
  title: "Senior Operations Associate",
  first_published: "2026-09-03T09:00:00Z",
  absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4001005",
  location: { name: "Remote - USA" },
  departments: [{ name: "Operations" }],
  content: "&lt;p&gt;Remote operations role in the United States.&lt;/p&gt;",
};
const JOB_OPS_REMOTE_UK = {
  id: 4001006,
  title: "Operations Analyst",
  first_published: "2026-09-04T09:00:00Z",
  absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4001006",
  location: { name: "Remote - UK" },
  departments: [{ name: "Operations" }],
  content: "&lt;p&gt;Remote operations role in the UK.&lt;/p&gt;",
};

let server: TestServer;
let deps: WorkerDeps;
let queue: TaskQueue;
let db: Db;
let now = new Date("2026-09-05T06:00:00Z");
let user: User;

function setJobs(jobs: Array<Record<string, unknown>>) {
  server.setRoutes({
    "www.acme.example": acmeRoutes(),
    "acme.example": acmeRoutes(),
    "boards-api.greenhouse.io": greenhouseRoutes(jobs),
    "job-boards.greenhouse.io": {},
  });
}

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();

  server = await startTestServer({}, HOSTS);
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
  await db.execute(sql`truncate users, companies, career_sources, discovery_runs, scan_runs, scans, jobs, job_events, decisions, tasks, settings, ai_calls, company_profiles, company_suggestions, filter_suggestions, preference_profiles, cv_libraries restart identity cascade`);
  user = await ensureTestUser(db);
  now = new Date("2026-09-05T06:00:00Z");
  setJobs([JOB_OPERATIONS_MANAGER, JOB_ENGINEER, JOB_OPS_NEW_YORK, JOB_OPS_REMOTE_US, JOB_OPS_REMOTE_UK]);
});

async function setGate(gate: Partial<{ includeKeywords: string[]; excludeKeywords: string[]; seniorityKeywords: string[]; locationTerms: string[]; includeRemote: boolean; matchFields: string[] }>) {
  const value = {
    includeKeywords: ["operations"],
    excludeKeywords: [],
    matchFields: ["title"],
    locationTerms: [],
    includeRemote: true,
    ...gate,
  };
  await db.insert(schema.userSettings).values({ userId: user.id, key: "gate", value }).onConflictDoUpdate({ target: [schema.userSettings.userId, schema.userSettings.key], set: { value } });
}

async function addCompany(homepageUrl: string, domain: string, follower: User = user) {
  const [company] = await db.insert(schema.companies).values({ name: domain, homepageUrl, domain }).returning();
  await subscribeToCompany(db, follower.id, company!.id);
  await enqueueTask(db, "discover", { companyId: company!.id, reason: "added" }, {
    dedupeKey: dedupeKeyFor("discover", { companyId: company!.id }),
    priority: priorityFor("discover"),
  });
  return company!;
}

/** One account's view of the shared postings: only rows that passed its gate exist. */
async function jobsInTable(viewer: User = user) {
  return db
    .select({
      jobId: schema.jobs.id,
      title: schema.jobs.title,
      location: schema.jobs.location,
      status: schema.jobs.status,
      inTable: schema.userJobs.inTable,
      nearMiss: schema.userJobs.nearMiss,
      keywordTerms: schema.userJobs.keywordTerms,
      postedAt: schema.jobs.postedAt,
      firstSeenAt: schema.jobs.firstSeenAt,
      closedAt: schema.jobs.closedAt,
      seeded: schema.userJobs.seeded,
      missingScans: schema.jobs.missingScans,
      url: schema.jobs.url,
    })
    .from(schema.userJobs)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.userJobs.jobId))
    .where(eq(schema.userJobs.userId, viewer.id))
    .orderBy(schema.jobs.title);
}

describe("end to end", () => {
  it("refreshes branding independently without adding careers sources or roles", async () => {
    const [company] = await db.insert(schema.companies).values({ name: "Acme", domain: "acme.example", homepageUrl: "https://www.acme.example/", faviconUrl: "https://old.example/icon.png" }).returning();
    await enqueueTask(db, "discover", { companyId: company!.id, logoOnly: true, homepageUrl: company!.homepageUrl });
    await queue.drain();
    const [updated] = await db.select().from(schema.companies).where(eq(schema.companies.id, company!.id));
    expect(updated!.faviconUrl).toBe("https://www.acme.example/favicon.png");
    // The image itself is stored, not just its address: every page then serves the same bytes.
    const stored = await readCompanyLogo(db, company!.id);
    expect(stored?.contentType).toBe("image/png");
    expect(stored?.bytes).toEqual(pngBytes());
    expect(updated!.logoFetchedAt).toBeInstanceOf(Date);
    expect(updated!.logoAttempts).toBe(0);
    expect(await db.select().from(schema.careerSources)).toHaveLength(0);
    expect(await db.select().from(schema.discoveryRuns)).toHaveLength(0);
    expect(await db.select().from(schema.jobs)).toHaveLength(0);
    await enqueueTask(db, "discover", { companyId: company!.id, logoOnly: true, homepageUrl: "https://old.example/" });
    await queue.drain();
    const [afterStale] = await db.select().from(schema.companies).where(eq(schema.companies.id, company!.id));
    expect(afterStale!.faviconUrl).toBe(updated!.faviconUrl);
  });
  it("names a company from a pasted board when its name is only the domain label", async () => {
    await setGate({});
    const [placeholder] = await db.insert(schema.companies).values({ name: "Acme", domain: "acme.example", homepageUrl: "https://www.acme.example/" }).returning();
    const [named] = await db.insert(schema.companies).values({ name: "Acme Robotics Ltd", domain: "acme-named.example", homepageUrl: "https://www.acme-named.example/" }).returning();
    for (const company of [placeholder!, named!]) {
      await enqueueTask(db, "discover", { companyId: company.id, reason: "pasted", url: "https://boards.greenhouse.io/acme" }, {
        dedupeKey: dedupeKeyFor("discover", { companyId: company.id }), priority: priorityFor("discover"),
      });
    }
    await queue.drain();
    const [renamed] = await db.select().from(schema.companies).where(eq(schema.companies.id, placeholder!.id));
    expect(renamed!.name).toBe("Acme Robotics");
    const [kept] = await db.select().from(schema.companies).where(eq(schema.companies.id, named!.id));
    expect(kept!.name).toBe("Acme Robotics Ltd");
    expect(await db.select().from(schema.careerSources)).toHaveLength(2);
  });
  it("discovers the careers source from a homepage URL and scans it", async () => {
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();

    const [refreshed] = await db.select().from(schema.companies).where(eq(schema.companies.id, company.id));
    expect(refreshed!.name).toBe("Acme Robotics");
    expect(refreshed!.faviconUrl).toBe("https://www.acme.example/favicon.png");

    const [source] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, company.id));
    expect(source!.type).toBe("greenhouse");
    expect(source!.atsSlug).toBe("acme");
    expect(source!.confidence).toBeGreaterThanOrEqual(0.85);
    expect(source!.status).toBe("active");

    const [run] = await db.select().from(schema.discoveryRuns).where(eq(schema.discoveryRuns.companyId, company.id));
    expect(run!.status).toBe("resolved");
    expect((run!.log as string[]).join("\n")).toContain("landing page");

    const [scan] = await db.select().from(schema.scans);
    expect(scan!.status).toBe("ok");
    expect(scan!.postingsFound).toBe(5);
    expect(scan!.fetchMethod).toBe("api");
    // How large the input was, so an oversized board is visible before it exhausts the worker.
    expect(scan!.fetchedBytes).toBeGreaterThan(0);
  }, 60_000);

  it("stores every observed posting once and shows an account only its matching roles", async () => {
    await setGate({});
    await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();

    // The shared catalogue keeps the complete listing; the account's table keeps what passed its gate.
    expect(await db.select().from(schema.jobs)).toHaveLength(5);
    const rows = await jobsInTable();
    expect(rows).toHaveLength(4);
    const inTable = rows.filter((r) => r.inTable).map((r) => r.title);
    expect(inTable).toEqual(["Head of Business Operations", "Operations Analyst", "Operations Manager", "Senior Operations Associate"]);
    expect(rows.find((r) => r.title.startsWith("Software"))).toBeUndefined();
    expect(rows.find((r) => r.title === "Operations Manager")!.keywordTerms).toEqual(["operations"]);
    // Every role from the first scan is flagged as seeded so a day-one table is not read as news.
    expect(rows.every((r) => r.seeded)).toBe(true);
    // Non-matches never enter the account's table or get scored.
    expect(rows.some(r => r.nearMiss)).toBe(false);
    expect(await db.select().from(schema.userJobs)).toHaveLength(4);
  }, 60_000);

  it("filters by location, expanding UK and keeping UK-remote roles", async () => {
    await setGate({ locationTerms: ["UK"] });
    await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();

    const rows = await jobsInTable();
    const inTable = rows.filter((r) => r.inTable).map((r) => r.title);
    expect(inTable).toEqual(["Operations Analyst", "Operations Manager"]);
    // New York is out; "Remote - USA" is out because it names another region.
    expect(rows.find((r) => r.title === "Head of Business Operations")).toBeUndefined();
    expect(rows.find((r) => r.title === "Senior Operations Associate")).toBeUndefined();
    expect(rows.find((r) => r.title === "Operations Analyst")!.location).toBe("Remote - UK");
    // A role outside the location filter is not a near miss either: the filter is a hard boundary.
    expect(rows.some(r => r.nearMiss)).toBe(false);
  }, 60_000);

  it("re-evaluates the gate in place when the location filter changes", async () => {
    await setGate({});
    await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    expect((await jobsInTable()).filter((r) => r.inTable)).toHaveLength(4);

    await setGate({ locationTerms: ["London"] });
    await enqueueTask(db, "reevaluate_gate", {}, { dedupeKey: "reevaluate_gate", priority: 1 });
    await queue.drain();

    const rows = await jobsInTable();
    // London keeps the London role and the UK-remote role (remote work is matched at country
    // level), but drops New York, US-remote, and any other UK city.
    expect(rows.filter((r) => r.inTable).map((r) => r.title)).toEqual(["Operations Analyst", "Operations Manager"]);
  }, 60_000);

  it("marks a role New for seven days and counts how long it has been live", async () => {
    await setGate({});
    await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();

    const rows = await jobsInTable();
    const manager = rows.find((r) => r.title === "Operations Manager")!;
    // The board publishes first_published, so live-for counts from the real posted date.
    expect(manager.postedAt?.toISOString()).toBe("2026-09-02T09:00:00.000Z");
    const live = liveFor({ status: manager.status, postedAt: manager.postedAt, firstSeenAt: manager.firstSeenAt, closedAt: manager.closedAt }, now);
    expect(live).toEqual({ days: 2, basis: "posted" });
    expect(displayStatus({ status: manager.status, postedAt: manager.postedAt, firstSeenAt: manager.firstSeenAt, closedAt: manager.closedAt }, now)).toBe("new");

    const laterOn = new Date("2026-09-20T06:00:00Z");
    expect(displayStatus({ status: manager.status, postedAt: manager.postedAt, firstSeenAt: manager.firstSeenAt, closedAt: manager.closedAt }, laterOn)).toBe("active");
  }, 60_000);

  it("closes a removed role only after two consecutive successful scans", async () => {
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();

    // The Operations Manager posting disappears from the board.
    setJobs([JOB_ENGINEER, JOB_OPS_NEW_YORK, JOB_OPS_REMOTE_US, JOB_OPS_REMOTE_UK]);
    now = new Date("2026-09-06T06:00:00Z");
    await enqueueTask(db, "scan_company", { companyId: company.id, trigger: "manual" }, { dedupeKey: dedupeKeyFor("scan_company", { companyId: company.id }), priority: 5 });
    await queue.drain();

    let manager = (await jobsInTable()).find((r) => r.title === "Operations Manager")!;
    expect(manager.status).toBe("open");
    expect(manager.missingScans).toBe(1);

    now = new Date("2026-09-07T06:00:00Z");
    await enqueueTask(db, "scan_company", { companyId: company.id, trigger: "manual" }, { dedupeKey: dedupeKeyFor("scan_company", { companyId: company.id }), priority: 5 });
    await queue.drain();

    manager = (await jobsInTable()).find((r) => r.title === "Operations Manager")!;
    expect(manager.status).toBe("closed");
    expect(manager.closedAt).toBeInstanceOf(Date);
    const events = await db.select().from(schema.jobEvents);
    expect(events.some((e) => e.type === "closed")).toBe(true);
  }, 90_000);

  it("never closes a role when the source fails", async () => {
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();

    server.setRoutes({
      "www.acme.example": acmeRoutes(),
      "acme.example": acmeRoutes(),
      "boards-api.greenhouse.io": { "/v1/boards/acme/jobs": { status: 500, body: { error: "boom" } } },
      "job-boards.greenhouse.io": {},
    });
    for (let i = 0; i < 2; i++) {
      now = new Date(now.getTime() + 86_400_000);
      await enqueueTask(db, "scan_company", { companyId: company.id, trigger: "manual" }, { dedupeKey: dedupeKeyFor("scan_company", { companyId: company.id }), priority: 5 });
      await queue.drain();
    }

    const rows = await jobsInTable();
    expect(rows.every((r) => r.status === "open")).toBe(true);
    expect(rows.every((r) => r.missingScans === 0)).toBe(true);
    const scans = await db.select().from(schema.scans).orderBy(desc(schema.scans.startedAt));
    expect(scans[0]!.status).toBe("failed");
    const [source] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, company.id));
    expect(source!.consecutiveFailures).toBe(2);
  }, 90_000);

  it("reopens a role whose posting comes back", async () => {
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();

    // Only the one role comes down: a board cut to a fraction of itself would be a collapse, not a close.
    setJobs([JOB_ENGINEER, JOB_OPS_NEW_YORK, JOB_OPS_REMOTE_US, JOB_OPS_REMOTE_UK]);
    for (let i = 0; i < 2; i++) {
      now = new Date(now.getTime() + 86_400_000);
      await enqueueTask(db, "scan_company", { companyId: company.id, trigger: "manual" }, { dedupeKey: dedupeKeyFor("scan_company", { companyId: company.id }), priority: 5 });
      await queue.drain();
    }
    expect((await jobsInTable()).find((r) => r.title === "Operations Manager")!.status).toBe("closed");

    setJobs([JOB_OPERATIONS_MANAGER, JOB_ENGINEER, JOB_OPS_NEW_YORK, JOB_OPS_REMOTE_US, JOB_OPS_REMOTE_UK]);
    now = new Date(now.getTime() + 86_400_000);
    await enqueueTask(db, "scan_company", { companyId: company.id, trigger: "manual" }, { dedupeKey: dedupeKeyFor("scan_company", { companyId: company.id }), priority: 5 });
    await queue.drain();

    const manager = (await jobsInTable()).find((r) => r.title === "Operations Manager")!;
    expect(manager.status).toBe("open");
    const events = await db.select().from(schema.jobEvents);
    expect(events.some((e) => e.type === "reopened")).toBe(true);
  }, 90_000);

  it("asks for confirmation instead of guessing when discovery is uncertain", async () => {
    await setGate({});
    server.setRoutes({
      "www.orbital.example": {
        "/": { body: `<!doctype html><html><head><title>Orbital</title></head><body><nav><a href="/">Home</a><a href="/tech">Tech</a><a href="/news">News</a><a href="/contact">Contact</a><a href="/legal">Legal</a></nav></body></html>` },
        "/robots.txt": { body: "User-agent: *\nAllow: /\n", contentType: "text/plain" },
      },
      "orbital.example": {},
    });
    const company = await addCompany("https://www.orbital.example/", "orbital.example");
    await queue.drain();

    const [run] = await db.select().from(schema.discoveryRuns).where(eq(schema.discoveryRuns.companyId, company.id));
    expect(run!.status).toBe("not_found");
    const sources = await db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, company.id));
    expect(sources).toHaveLength(0);

    // As a last resort discovery guesses an applicant tracking slug from the domain name. Those
    // guesses must be refused by the host map, not answered by a real board: otherwise the result
    // of this test depends on who happens to own the slug "orbital".
    const log = (run!.log as string[]).join("\n");
    expect(log).toContain("not in the test host map");
    expect(server.requests.every((r) => HOSTS.includes(r.host))).toBe(true);
  }, 60_000);

  it("recovers a company with no discovered source when a person supplies its board URL", async () => {
    await setGate({});
    server.setRoutes({
      "www.orbital.example": {
        "/": { body: `<!doctype html><html><head><title>Orbital</title></head><body><nav><a href="/">Home</a><a href="/tech">Tech</a><a href="/news">News</a><a href="/contact">Contact</a><a href="/legal">Legal</a></nav></body></html>` },
        "/robots.txt": { body: "User-agent: *\nAllow: /\n", contentType: "text/plain" },
      },
      "orbital.example": {},
      "boards-api.greenhouse.io": greenhouseRoutes([JOB_OPERATIONS_MANAGER, JOB_ENGINEER, JOB_OPS_NEW_YORK, JOB_OPS_REMOTE_US, JOB_OPS_REMOTE_UK]),
      "job-boards.greenhouse.io": {},
    });
    const company = await addCompany("https://www.orbital.example/", "orbital.example");
    await queue.drain();

    const [automaticRun] = await db.select().from(schema.discoveryRuns)
      .where(eq(schema.discoveryRuns.companyId, company.id));
    expect(automaticRun!.status).toBe("not_found");
    expect(await db.select().from(schema.careerSources)
      .where(eq(schema.careerSources.companyId, company.id))).toHaveLength(0);

    // This is the worker half of the assisted path. The web action has a database integration
    // test proving that the pasted value is queued unchanged with this reason and a URL-specific
    // dedupe key; here the real discovery and scan handlers consume that task end to end.
    const suppliedUrl = "https://job-boards.greenhouse.io/acme";
    await enqueueTask(db, "discover", { companyId: company.id, url: suppliedUrl, reason: "pasted" }, {
      dedupeKey: `discover:${company.id}:url:${suppliedUrl}`,
      priority: 1,
    });
    await queue.drain();

    const runs = await db.select().from(schema.discoveryRuns)
      .where(eq(schema.discoveryRuns.companyId, company.id));
    expect(runs).toHaveLength(2);
    const recoveredRun = runs.find((run) => run.id !== automaticRun!.id);
    expect(recoveredRun).toMatchObject({ status: "resolved" });
    expect(recoveredRun!.chosenSourceId).not.toBeNull();
    const [source] = await db.select().from(schema.careerSources)
      .where(eq(schema.careerSources.companyId, company.id));
    expect(source).toMatchObject({
      id: recoveredRun!.chosenSourceId,
      type: "greenhouse",
      atsSlug: "acme",
      url: suppliedUrl,
      status: "active",
    });
    const [scan] = await db.select().from(schema.scans).where(eq(schema.scans.sourceId, source!.id));
    expect(scan).toMatchObject({ status: "ok", postingsFound: 5 });
    expect((await jobsInTable()).map((job) => job.title).sort()).toEqual([
      "Head of Business Operations",
      "Operations Analyst",
      "Operations Manager",
      "Senior Operations Associate",
    ]);
  }, 90_000);

  it("records a scan run that the health page can report on", async () => {
    await setGate({});
    await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();

    await enqueueTask(db, "run_daily", { trigger: "manual" }, { dedupeKey: null, priority: 5 });
    await queue.drain();

    const [run] = await db.select().from(schema.scanRuns).orderBy(desc(schema.scanRuns.startedAt)).limit(1);
    expect(run!.companiesTotal).toBe(1);
    expect(run!.companiesOk).toBe(1);
    expect(run!.companiesFailed).toBe(0);
  }, 60_000);
});


describe("functional review regressions", () => {
  it("refreshes metadata, descriptions and gate results on an existing posting", async () => {
    await setGate({ locationTerms: ["UK"] });
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [saved] = await db.select().from(schema.jobs).where(eq(schema.jobs.externalKey, "id:4001001"));
    // The board lists without descriptions, so the role the account wants had its description
    // fetched from the detail endpoint by the task the first scan queued.
    expect(saved!.descriptionText).toContain("Own operations for our London site.");
    await db.insert(schema.decisions).values({ userId: user.id, jobId: saved!.id, decision: "skip", reason: "Too junior", jobTitle: saved!.title, companyName: company.name });
    setJobs([{ ...JOB_OPERATIONS_MANAGER, title: "Engineering Manager", location: { name: "New York, USA" }, offices: [], absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4001001?updated=1" }, JOB_ENGINEER, JOB_OPS_NEW_YORK, JOB_OPS_REMOTE_US, JOB_OPS_REMOTE_UK]);
    const [source] = await db.select().from(schema.careerSources);
    await _scanSourceForTests(deps, company, source!, await deps.settings(), null);
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.externalKey, "id:4001001"));
    expect(job!.title).toBe("Engineering Manager");
    expect(job!.url).toContain("updated=1");
    // A listing that carries no description never blanks the stored snapshot.
    expect(job!.descriptionText).toContain("Own operations for our London site.");
    expect(job!.descriptionSource).toBe("direct");
    expect(job!.descriptionTruncated).toBe(false);
    const [view] = await db.select().from(schema.userJobs).where(eq(schema.userJobs.jobId, job!.id));
    expect(view!.inTable).toBe(false);
    expect(view!.locationOk).toBe(false);
    expect(view!.nearMiss).toBe(false);

    // The board says the posting changed: the scan queues the detail fetch again and the
    // refreshed text replaces the snapshot, truncated at the 30k cap.
    setJobs([{ ...JOB_OPERATIONS_MANAGER, updated_at: "2026-09-05T08:00:00Z", content: "Operations planning and reporting. ".repeat(1200) }]);
    await _scanSourceForTests(deps, company, source!, await deps.settings(), null);
    await queue.drain();
    const [truncated] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, saved!.id));
    expect(truncated!.descriptionText).toHaveLength(30000);
    expect(truncated!.descriptionText).toContain("Operations planning and reporting.");
    expect(truncated!.descriptionTruncated).toBe(true);
    expect(truncated!.descriptionHash).toBe(sha1(truncated!.descriptionText!));
  }, 90_000);

  it("never closes a role on a SmartRecruiters listing the adapter could not finish", async () => {
    await setGate({});
    server.setRoutes({ "api.smartrecruiters.com": smartRecruitersRoutes("small") });
    const [company] = await db.insert(schema.companies).values({ name: "Orbital", domain: "orbital.example", homepageUrl: "https://www.orbital.example/" }).returning();
    await subscribeToCompany(db, user.id, company!.id);
    const [source] = await db.insert(schema.careerSources).values({
      companyId: company!.id,
      type: "smartrecruiters",
      url: "https://jobs.smartrecruiters.com/orbital",
      apiUrl: "https://api.smartrecruiters.com/v1/companies/orbital/postings",
      atsSlug: "orbital",
      confidence: 0.9,
      status: "active",
    }).returning();
    const settings = await deps.settings();

    const complete = await _scanSourceForTests(deps, company!, source!, settings, null);
    expect(complete.status).toBe("ok");
    expect((await jobsInTable()).map((r) => r.title)).toEqual(["Operations Analyst", "Operations Lead", "Operations Manager"]);

    // The board grows past what ten pages can hold and the three followed roles fall off the end.
    // Two consecutive scans is exactly what closes a role, so if a truncated listing ever counted
    // as a complete one, this is where the false "closed" rows would appear.
    server.setRoutes({ "api.smartrecruiters.com": smartRecruitersRoutes("capped") });
    for (const _ of [1, 2]) {
      const [current] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source!.id));
      const outcome = await _scanSourceForTests(deps, company!, current!, settings, null);
      expect(outcome.status).toBe("partial");
      expect(outcome.closedCount).toBe(0);
      expect(outcome.postingsFound).toBe(10_000);
    }

    const rows = await jobsInTable();
    expect(rows.map((r) => r.title)).toEqual(["Operations Analyst", "Operations Lead", "Operations Manager"]);
    expect(rows.every((r) => r.status === "open")).toBe(true);
    expect(rows.every((r) => r.closedAt === null)).toBe(true);
    // A partial scan is not evidence of absence, so it does not even count as a miss.
    expect(rows.every((r) => r.missingScans === 0)).toBe(true);
    const [scan] = await db.select().from(schema.scans).where(eq(schema.scans.sourceId, source!.id)).orderBy(desc(schema.scans.startedAt)).limit(1);
    expect(scan!.status).toBe("partial");
    expect(scan!.error).toContain("roles unread");
  }, 90_000);

  it("archives retained non-matches but preserves active decisions and saved CVs", async () => {
    await setGate({});
    await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const rows = await jobsInTable();
    expect(rows).toHaveLength(4);
    await db.insert(schema.decisions).values({ userId: user.id, jobId: rows[0]!.jobId, decision: "skip", reason: "Too junior", jobTitle: rows[0]!.title, companyName: "Acme" });
    await db.update(schema.userJobs).set({ archivedAt: new Date() }).where(eq(schema.userJobs.jobId, rows[1]!.jobId));
    await db.insert(schema.cvDrafts).values({ userId: user.id, jobId: rows[2]!.jobId, jobTitle: rows[2]!.title, companyName: "Acme", jobDescription: "Role", libraryVersion: 1, librarySnapshot: { name: "Test", contact: "", profile: "", entries: [] }, model: "fixture" });
    await setGate({ includeKeywords: ["no-match"] });
    const result = await reevaluateGate(db, user.id, await deps.userSettings(user.id));
    expect(result.removed).toBe(0);
    const kept = await db.select().from(schema.userJobs);
    expect(kept).toHaveLength(4);
    // The decided role and the role a CV was written for stay in the table; the already-archived
    // row keeps its timestamp and the fourth is archived by the narrowed gate.
    expect(kept.filter(job => job.archivedAt)).toHaveLength(2);
    expect(kept.find(job => job.jobId === rows[0]!.jobId)!.archivedAt).toBeNull();
    expect(kept.find(job => job.jobId === rows[2]!.jobId)!.archivedAt).toBeNull();
    expect(kept.every(j => !j.inTable && !j.nearMiss)).toBe(true);
    expect((await db.select().from(schema.decisions))[0]!.reason).toBe("Too junior");
  });

  it("archives an account's non-matches after the scan commits, not inside it", async () => {
    // `archiveNonMatches` takes a transaction of its own and runs once the scan has committed, so
    // the source's row lock is not held for it. The effect must be the same: a role the account's
    // gate no longer admits is archived by the scan that observed it.
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    expect((await jobsInTable()).filter(r => r.inTable)).toHaveLength(4);

    await setGate({ includeKeywords: ["no-match"] });
    const [source] = await db.select().from(schema.careerSources);
    const outcome = await _scanSourceForTests(deps, company, source!, await deps.settings(), null);
    expect(outcome.status).toBe("ok");
    const views = await db.select().from(schema.userJobs);
    expect(views.every(v => !v.inTable && v.archivedAt !== null)).toBe(true);
  }, 60_000);

  it("brings back on a later scan what the gate archived, never what the person archived", async () => {
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [source] = await db.select().from(schema.careerSources);
    const scan = async () => {
      now = new Date(now.getTime() + 86_400_000);
      const [current] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source!.id));
      return _scanSourceForTests(deps, company, current!, await deps.settings(), null);
    };
    await setGate({ includeKeywords: ["no-match"] });
    await scan();
    const archived = await db.select().from(schema.userJobs);
    expect(archived).toHaveLength(4);
    expect(archived.every(v => !v.inTable && v.archivedAt !== null && v.gateArchivedAt?.getTime() === v.archivedAt.getTime())).toBe(true);
    // The person restored one and put it away again themselves: that archive is theirs now.
    const theirs = archived[0]!;
    await db.update(schema.userJobs).set({ archivedAt: new Date(now.getTime() + 60_000) })
      .where(and(eq(schema.userJobs.userId, user.id), eq(schema.userJobs.jobId, theirs.jobId)));

    await setGate({});
    expect((await scan()).status).toBe("ok");
    const views = await db.select().from(schema.userJobs);
    expect(views.every(v => v.inTable)).toBe(true);
    expect(views.filter(v => v.archivedAt === null)).toHaveLength(3);
    expect(views.find(v => v.jobId === theirs.jobId)!.archivedAt).not.toBeNull();
  }, 90_000);

  it("rewrites no view on a scan that changes nothing", async () => {
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [source] = await db.select().from(schema.careerSources);
    const before = await db.select({ jobId: schema.userJobs.jobId, updatedAt: schema.userJobs.updatedAt, xmin: sql<string>`xmin::text` }).from(schema.userJobs).orderBy(schema.userJobs.jobId);
    now = new Date(now.getTime() + 86_400_000);
    expect((await _scanSourceForTests(deps, company, source!, await deps.settings(), null)).status).toBe("ok");
    const after = await db.select({ jobId: schema.userJobs.jobId, updatedAt: schema.userJobs.updatedAt, xmin: sql<string>`xmin::text` }).from(schema.userJobs).orderBy(schema.userJobs.jobId);
    expect(after).toEqual(before);
  }, 60_000);

  it("does not queue a view again whose scoring completed without a score", async () => {
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [source] = await db.select().from(schema.careerSources);
    const aiDeps = { ...deps, ai: { ...deps.ai, enabled: true } } as unknown as WorkerDeps;
    await db.insert(schema.userSettings).values({ userId: user.id, key: "aiBudgetUsd", value: 25 });
    const views = await db.select().from(schema.userJobs).orderBy(schema.userJobs.jobId);
    // The model was asked about the first and gave nothing usable; the rest were never scored.
    await db.update(schema.userJobs).set({ fitScore: null, scoredAt: now }).where(eq(schema.userJobs.jobId, views[0]!.jobId));
    await db.update(schema.userJobs).set({ fitScore: null, scoredAt: null }).where(sql`${schema.userJobs.jobId} <> ${views[0]!.jobId}`);
    await db.delete(schema.tasks);
    const queuedFor = async () => (await db.select().from(schema.tasks).where(eq(schema.tasks.type, "score_job"))).map(t => (t.payload as { jobId: string }).jobId);

    now = new Date(now.getTime() + 86_400_000);
    await _scanSourceForTests(aiDeps, company, source!, await deps.settings(), null);
    expect(await queuedFor()).not.toContain(views[0]!.jobId);
    expect(await queuedFor()).toHaveLength(views.length - 1);

    // Nor does re-evaluating the gate, which every boot and settings save does.
    await db.delete(schema.tasks);
    await reevaluateGate(db, user.id, await deps.userSettings(user.id), now);
    expect(await queuedFor()).not.toContain(views[0]!.jobId);
  }, 60_000);

  it("creates no view for a role that closed long ago, and still puts older views away", async () => {
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const late = await ensureTestUser(db, "late-closed@example.com", "member");
    await db.insert(schema.userSettings).values({ userId: late.id, key: "gate", value: { includeKeywords: ["operations", "engineer"], excludeKeywords: [], matchFields: ["title"], locationTerms: [], includeRemote: true } });
    await subscribeToCompany(db, late.id, company.id);
    const byKey = async (id: number) => (await db.select().from(schema.jobs).where(eq(schema.jobs.externalKey, `id:${id}`)))[0]!;
    const longAgo = await byKey(JOB_OPERATIONS_MANAGER.id);
    const lately = await byKey(JOB_ENGINEER.id);
    await db.update(schema.jobs).set({ status: "closed", closedAt: new Date(now.getTime() - 60 * 86_400_000) }).where(eq(schema.jobs.id, longAgo.id));
    await db.update(schema.jobs).set({ status: "closed", closedAt: new Date(now.getTime() - 10 * 86_400_000) }).where(eq(schema.jobs.id, lately.id));

    await reevaluateGate(db, late.id, await deps.userSettings(late.id), now, { companyId: company.id });
    const lateViews = new Set((await db.select().from(schema.userJobs).where(eq(schema.userJobs.userId, late.id))).map(v => v.jobId));
    expect(lateViews.has(longAgo.id)).toBe(false);
    expect(lateViews.has(lately.id)).toBe(true);
    expect(lateViews.size).toBe(4);

    // The first account already had a view of the role closed long ago: narrowing still reaches it.
    await setGate({ includeKeywords: ["no-match"] });
    await reevaluateGate(db, user.id, await deps.userSettings(user.id), now);
    const [oldView] = await db.select().from(schema.userJobs).where(and(eq(schema.userJobs.userId, user.id), eq(schema.userJobs.jobId, longAgo.id)));
    expect(oldView).toMatchObject({ inTable: false });
    expect(oldView!.archivedAt).not.toBeNull();
  }, 60_000);

  it("limits description gate refreshes to their role and rechecks old closed roles globally", async () => {
    await setGate({});
    await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const rows = await jobsInTable();
    await db.update(schema.jobs).set({ status: "closed", closedAt: new Date("2000-01-01") });
    await setGate({ includeKeywords: ["no-match"] });
    const targeted = await reevaluateGate(db, user.id, await deps.userSettings(user.id), new Date(), { jobId: rows[0]!.jobId });
    expect(targeted.examined).toBe(1);
    expect(targeted.removed).toBe(0);
    expect((await db.select().from(schema.userJobs)).filter(job => job.archivedAt)).toHaveLength(1);
    const all = await reevaluateGate(db, user.id, await deps.userSettings(user.id));
    expect(all.removed).toBe(0);
    expect((await db.select().from(schema.userJobs)).filter(job => job.archivedAt)).toHaveLength(rows.length);
  });

  it("resets the miss count of every role a partial scan saw, and counts nothing against the rest", async () => {
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [source] = await db.select().from(schema.careerSources);
    await db.update(schema.jobs).set({ missingScans: 1 });
    await db.insert(schema.scans).values({ sourceId: source!.id, status: "ok", postingsFound: 20, startedAt: new Date("2099-01-01") });
    setJobs([JOB_OPERATIONS_MANAGER, JOB_ENGINEER]);
    const outcome = await _scanSourceForTests(deps, company, source!, await deps.settings(), null);
    expect(outcome.status).toBe("partial");
    const jobs = await db.select().from(schema.jobs);
    expect(jobs.every(job => job.status === "open")).toBe(true);
    // Listed by the partial scan: still there, so the earlier miss no longer counts.
    const seen = new Set([`id:${JOB_OPERATIONS_MANAGER.id}`, `id:${JOB_ENGINEER.id}`]);
    expect(jobs.filter(job => seen.has(job.externalKey)).map(job => job.missingScans)).toEqual([0, 0]);
    // Not listed by it: an incomplete listing is no evidence of absence, so nothing moves.
    expect(jobs.filter(job => !seen.has(job.externalKey)).every(job => job.missingScans === 1)).toBe(true);
  }, 60_000);

  it("reopens a role a partial scan lists with a fresh miss count, so one later miss cannot close it", async () => {
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [source] = await db.select().from(schema.careerSources);
    const scanOn = async (day: string) => {
      now = new Date(`${day}T06:00:00Z`);
      const [current] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source!.id));
      return _scanSourceForTests(deps, company, current!, await deps.settings(), null);
    };
    const manager = async () => (await db.select().from(schema.jobs).where(eq(schema.jobs.externalKey, `id:${JOB_OPERATIONS_MANAGER.id}`)))[0]!;

    // Two consecutive successful misses close it.
    setJobs([JOB_ENGINEER, JOB_OPS_NEW_YORK, JOB_OPS_REMOTE_US, JOB_OPS_REMOTE_UK]);
    await scanOn("2026-09-06");
    await scanOn("2026-09-07");
    expect(await manager()).toMatchObject({ status: "closed", missingScans: 2 });

    // A partial scan (the listing collapsed against a large previous ok scan) lists it again.
    const [inflated] = await db.insert(schema.scans).values({ sourceId: source!.id, status: "ok", postingsFound: 20, startedAt: new Date("2026-09-07T12:00:00Z") }).returning();
    setJobs([JOB_OPERATIONS_MANAGER, JOB_ENGINEER]);
    expect((await scanOn("2026-09-08")).status).toBe("partial");
    expect(await manager()).toMatchObject({ status: "open", missingScans: 0, closedAt: null });
    await db.delete(schema.scans).where(eq(schema.scans.id, inflated!.id));

    // One ok miss after that is the first of two, not the second.
    setJobs([JOB_ENGINEER, JOB_OPS_NEW_YORK, JOB_OPS_REMOTE_US, JOB_OPS_REMOTE_UK]);
    expect((await scanOn("2026-09-09")).status).toBe("ok");
    expect(await manager()).toMatchObject({ status: "open", missingScans: 1 });
    await scanOn("2026-09-10");
    expect(await manager()).toMatchObject({ status: "closed", missingScans: 2 });
  }, 90_000);

  it("closes only on consecutive misses: a role listed again between two misses stays open", async () => {
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [source] = await db.select().from(schema.careerSources);
    const scanOn = async (day: string) => {
      now = new Date(`${day}T06:00:00Z`);
      const [current] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source!.id));
      return _scanSourceForTests(deps, company, current!, await deps.settings(), null);
    };
    const manager = async () => (await db.select().from(schema.jobs).where(eq(schema.jobs.externalKey, `id:${JOB_OPERATIONS_MANAGER.id}`)))[0]!;
    const without = [JOB_ENGINEER, JOB_OPS_NEW_YORK, JOB_OPS_REMOTE_US, JOB_OPS_REMOTE_UK];

    setJobs(without);
    expect((await scanOn("2026-09-06")).status).toBe("ok");
    expect(await manager()).toMatchObject({ status: "open", missingScans: 1 });
    setJobs([JOB_OPERATIONS_MANAGER, ...without]);
    expect((await scanOn("2026-09-07")).status).toBe("ok");
    expect(await manager()).toMatchObject({ status: "open", missingScans: 0 });
    setJobs(without);
    expect((await scanOn("2026-09-08")).status).toBe("ok");
    expect(await manager()).toMatchObject({ status: "open", missingScans: 1 });
  }, 90_000);

  it("counts two successful misses forty minutes apart as one, and closes on the next day's", async () => {
    // A rescan after the daily scan, a retried task or a backlog that runs two days' tasks back to
    // back all make two complete scans within the hour. A role briefly unpublished is absent from
    // both, so they are one observation, not two.
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [source] = await db.select().from(schema.careerSources);
    const scanAt = async (at: string) => {
      now = new Date(at);
      const [current] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source!.id));
      return _scanSourceForTests(deps, company, current!, await deps.settings(), null);
    };
    const manager = async () => (await db.select().from(schema.jobs).where(eq(schema.jobs.externalKey, `id:${JOB_OPERATIONS_MANAGER.id}`)))[0]!;

    setJobs([JOB_ENGINEER, JOB_OPS_NEW_YORK, JOB_OPS_REMOTE_US, JOB_OPS_REMOTE_UK]);
    expect((await scanAt("2026-09-06T06:00:00Z")).status).toBe("ok");
    expect(await manager()).toMatchObject({ status: "open", missingScans: 1, firstMissedAt: new Date("2026-09-06T06:00:00Z") });
    const rescan = await scanAt("2026-09-06T06:40:00Z");
    expect(rescan).toMatchObject({ status: "ok", closedCount: 0 });
    expect(await manager()).toMatchObject({ status: "open", missingScans: 1, firstMissedAt: new Date("2026-09-06T06:00:00Z") });

    const nextDay = await scanAt("2026-09-07T06:00:00Z");
    expect(nextDay.closedCount).toBe(1);
    expect(await manager()).toMatchObject({ status: "closed", missingScans: 2 });

    // Listed again: open, with no miss and no first-miss time left over.
    setJobs([JOB_OPERATIONS_MANAGER, JOB_ENGINEER, JOB_OPS_NEW_YORK, JOB_OPS_REMOTE_US, JOB_OPS_REMOTE_UK]);
    await scanAt("2026-09-08T06:00:00Z");
    expect(await manager()).toMatchObject({ status: "open", missingScans: 0, firstMissedAt: null });
  }, 90_000);

  it("closes nothing when a board that listed roles comes back empty, twice", async () => {
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [source] = await db.select().from(schema.careerSources);
    setJobs([]);
    for (const day of ["2026-09-06", "2026-09-07"]) {
      now = new Date(`${day}T06:00:00Z`);
      const [current] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source!.id));
      expect((await _scanSourceForTests(deps, company, current!, await deps.settings(), null)).status).toBe("suspect_empty");
    }
    const scans = await db.select().from(schema.scans).where(eq(schema.scans.sourceId, source!.id)).orderBy(desc(schema.scans.startedAt));
    expect(scans.slice(0, 2).map(scan => scan.status)).toEqual(["suspect_empty", "suspect_empty"]);
    const jobs = await db.select().from(schema.jobs);
    expect(jobs).toHaveLength(5);
    expect(jobs.every(job => job.status === "open" && job.missingScans === 0)).toBe(true);
    // An empty board where there were roles is worth finding again.
    const rediscovery = await db.select().from(schema.tasks).where(sql`type = 'discover' and payload->>'reason' = 'suspect_empty'`);
    expect(rediscovery).toHaveLength(1);
  }, 90_000);

  it("does not call an unextractable HTML page a successful empty scan", async () => {
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [source] = await db.insert(schema.careerSources).values({ companyId: company.id, type: "html", url: "https://www.acme.example/empty" }).returning();
    server.setRoutes({ "www.acme.example": { "/empty": { body: "<html><body>Loading careers...</body></html>" }, "/robots.txt": { body: "User-agent: *\nAllow: /" } } });
    const outcome = await _scanSourceForTests(deps, company, source!, await deps.settings(), null);
    expect(outcome.status).toBe("failed");
  }, 60_000);

  it("refreshes matched-term chips even when table membership is unchanged", async () => {
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    await setGate({ includeKeywords: ["operations", "manager"] });
    await enqueueTask(db, "reevaluate_gate", {});
    await queue.drain();
    const [job] = await db.select({ keywordTerms: schema.userJobs.keywordTerms, inTable: schema.userJobs.inTable }).from(schema.userJobs)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.userJobs.jobId)).where(eq(schema.jobs.externalKey, "id:4001001"));
    expect(job!.keywordTerms).toEqual(["operations", "manager"]);
    expect(job!.inTable).toBe(true);
  }, 60_000);

  it("defers a description-only gate to a queued description fetch instead of rejecting the role", async () => {
    // Greenhouse lists 2,000+ roles without descriptions, so a gate that matches on the description
    // cannot decide at scan time. The posting must be deferred, not rejected, and its description
    // queued even though no follower has admitted it yet.
    await setGate({});
    const reader = await ensureTestUser(db, "description-gate@example.com", "member");
    await db.insert(schema.userSettings).values({ userId: reader.id, key: "gate",
      value: { includeKeywords: ["robotics"], excludeKeywords: [], matchFields: ["description"], locationTerms: [], includeRemote: true } })
      .onConflictDoUpdate({ target: [schema.userSettings.userId, schema.userSettings.key], set: { value: { includeKeywords: ["robotics"], excludeKeywords: [], matchFields: ["description"], locationTerms: [], includeRemote: true } } });
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await subscribeToCompany(db, reader.id, company.id);
    deps.invalidateSettings();
    await queue.drain();
    const [source] = await db.select().from(schema.careerSources);

    const TITLE_MATCH = { id: 4002001, title: "Operations Lead", first_published: "2026-09-04T09:00:00Z",
      absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4002001", location: { name: "London, UK" },
      departments: [{ name: "Operations" }], content: "&lt;p&gt;Run the London site.&lt;/p&gt;" };
    const DESCRIPTION_MATCH = { id: 4002002, title: "Facilities Coordinator", first_published: "2026-09-04T09:00:00Z",
      absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4002002", location: { name: "London, UK" },
      departments: [{ name: "Workplace" }], content: "&lt;p&gt;Look after the robotics labs.&lt;/p&gt;" };
    setJobs([JOB_OPERATIONS_MANAGER, JOB_ENGINEER, JOB_OPS_NEW_YORK, JOB_OPS_REMOTE_US, JOB_OPS_REMOTE_UK, TITLE_MATCH, DESCRIPTION_MATCH]);
    const outcome = await _scanSourceForTests(deps, company, source!, await deps.settings(), null);
    // The listing was read in full, so the scan is still a successful one and may close roles.
    expect(outcome.status).toBe("ok");

    const [titleMatch] = await db.select().from(schema.jobs).where(eq(schema.jobs.externalKey, "id:4002001"));
    const [descriptionMatch] = await db.select().from(schema.jobs).where(eq(schema.jobs.externalKey, "id:4002002"));
    // The title match is admitted at scan time; the description match is deferred, not rejected.
    expect((await jobsInTable()).map(r => r.title)).toContain("Operations Lead");
    expect(await db.select().from(schema.userJobs).where(and(eq(schema.userJobs.userId, reader.id), eq(schema.userJobs.jobId, descriptionMatch!.id)))).toHaveLength(0);
    expect(descriptionMatch!.descriptionText).toBeNull();

    // A description task is queued for the deferred posting although nobody wanted it yet.
    const queued = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, "fetch_description"), eq(schema.tasks.status, "queued")));
    const queuedJobIds = queued.map(t => (t.payload as { jobId: string }).jobId);
    expect(queuedJobIds).toContain(descriptionMatch!.id);
    expect(queuedJobIds).toContain(titleMatch!.id);

    await queue.drain();
    const [readerView] = await db.select().from(schema.userJobs).where(and(eq(schema.userJobs.userId, reader.id), eq(schema.userJobs.jobId, descriptionMatch!.id)));
    expect(readerView!.inTable).toBe(true);
    expect(readerView!.keywordTerms).toEqual(["robotics"]);
    // The other account's title gate never admitted it: the description is shared, the table is not.
    expect(await db.select().from(schema.userJobs).where(and(eq(schema.userJobs.userId, user.id), eq(schema.userJobs.jobId, descriptionMatch!.id)))).toHaveLength(0);

    // A later scan of the same board queues nothing for postings whose description is stored.
    await _scanSourceForTests(deps, company, source!, await deps.settings(), null);
    const stillQueued = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, "fetch_description"), eq(schema.tasks.status, "queued")));
    expect(stillQueued).toHaveLength(0);
  }, 120_000);

  it("queues description snapshots without AI", async () => {
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    setJobs([{ ...JOB_OPERATIONS_MANAGER, id: 99999, content: "" }, JOB_ENGINEER, JOB_OPS_NEW_YORK, JOB_OPS_REMOTE_US, JOB_OPS_REMOTE_UK]);
    const [source] = await db.select().from(schema.careerSources);
    await _scanSourceForTests(deps, company, source!, await deps.settings(), null);
    const tasks = await db.select().from(schema.tasks).where(eq(schema.tasks.type, "fetch_description"));
    expect(tasks.some((task) => task.status === "queued")).toBe(true);
  }, 60_000);

  it("proposes an ATS migration instead of activating it silently", async () => {
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    await db.update(schema.careerSources).set({ atsSlug: "old-board", confirmedByUser: true });
    await enqueueTask(db, "discover", { companyId: company.id, reason: "failing" });
    await queue.drain();
    const sources = await db.select().from(schema.careerSources);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.atsSlug).toBe("old-board");
    const runs = await db.select().from(schema.discoveryRuns).orderBy(desc(schema.discoveryRuns.startedAt));
    expect(runs[0]!.status).toBe("needs_confirmation");
  }, 60_000);

  it("does not finish a daily run until all company tasks are terminal", async () => {
    await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    await db.insert(schema.companies).values({ name: "No source", domain: "none.example", homepageUrl: "https://none.example" });
    await handleRunDaily({ payload: { trigger: "manual" } } as never, deps);
    expect(await finaliseScanRuns(deps)).toBe(0);
    const [pending] = await db.select().from(schema.scanRuns);
    expect(pending!.finishedAt).toBeNull();
    await queue.drain();
    const [finished] = await db.select().from(schema.scanRuns);
    expect(finished!.finishedAt).not.toBeNull();
    expect(finished!.companiesOk).toBe(1);
    expect(finished!.companiesFailed).toBe(1);
  }, 60_000);

  it("reuses a score until its evidence changes", async () => {
    await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [view] = await db.select().from(schema.userJobs).where(eq(schema.userJobs.inTable, true));
    const scoreJob = vi.fn().mockResolvedValue({ score: 80, verdict: 'strong', rationale: 'Fixture' });
    const scoringDeps = { ...deps, ai: { ...deps.ai, enabled: true, scoreJob } } as unknown as WorkerDeps;
    const task = { payload: { userId: user.id, jobId: view!.jobId } } as never;
    const stored = async () => (await db.select().from(schema.userJobs).where(eq(schema.userJobs.jobId, view!.jobId)))[0]!;
    await handleScoreJob(task, scoringDeps);
    // What the score was computed from is kept on this account's view of the role, not as a row
    // per (account, role) in the settings table that every hot-path read would then ship.
    const first = await stored();
    expect(first.scoreInputHash).toMatch(/^[0-9a-f]{40}$/);
    expect(await db.select().from(schema.settings)).toHaveLength(0);

    expect(await handleScoreJob(task, scoringDeps)).toEqual({ skipped: "scoring inputs unchanged" });
    expect(scoreJob).toHaveBeenCalledTimes(1);
    // Skipped means nothing was asked of the model, so nothing was billed.
    expect(await db.select().from(schema.aiCalls)).toHaveLength(0);
    expect((await stored()).scoreInputHash).toBe(first.scoreInputHash);

    await db.insert(schema.cvLibraries).values({ userId: user.id, version: 100, content: { name: 'Test', contact: '', profile: 'New evidence', entries: [] } });
    await handleScoreJob(task, scoringDeps);
    expect(scoreJob).toHaveBeenCalledTimes(2);
    expect((await stored()).scoreInputHash).not.toBe(first.scoreInputHash);
  });
  it("skips an exhausted account's scoring cleanly, and scores again once its budget is raised", async () => {
    await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [view] = await db.select().from(schema.userJobs).where(eq(schema.userJobs.inTable, true));
    const scoreJob = vi.fn().mockResolvedValue({ score: 80, verdict: "strong", rationale: "Fixture" });
    const scoringDeps = { ...deps, ai: { ...deps.ai, enabled: true, scoreJob } } as unknown as WorkerDeps;
    const task = { payload: { userId: user.id, jobId: view!.jobId } } as never;
    // This account's $1 is spent, so this account stops; nobody else's budget is touched.
    await db.insert(schema.userSettings).values({ userId: user.id, key: "aiBudgetUsd", value: 1 });
    await db.insert(schema.aiCalls).values({ userId: user.id, callSite: "A5", model: "fixture", costUsd: 1, at: now });
    // A skipped result, not a thrown refusal: the task finishes done and never reaches Health's failures.
    expect(await handleScoreJob(task, scoringDeps)).toEqual({ skipped: "account ai budget exceeded" });
    expect(scoreJob).not.toHaveBeenCalled();
    // Nothing was attempted, so nothing more was billed and the role is simply left unscored.
    expect(await db.select().from(schema.aiCalls)).toHaveLength(1);
    const [unscored] = await db.select().from(schema.userJobs).where(eq(schema.userJobs.jobId, view!.jobId));
    expect(unscored!.fitScore).toBeNull();

    // An administrator raises this account's budget: the same role scores, on the same evidence.
    await db.update(schema.userSettings).set({ value: 50 })
      .where(and(eq(schema.userSettings.userId, user.id), eq(schema.userSettings.key, "aiBudgetUsd")));
    expect(await handleScoreJob(task, scoringDeps)).toMatchObject({ score: 80, verdict: "strong" });
    expect(scoreJob).toHaveBeenCalledTimes(1);
    const [scored] = await db.select().from(schema.userJobs).where(eq(schema.userJobs.jobId, view!.jobId));
    expect(scored!.fitScore).toBe(80);
  }, 60_000);

  it("leaves an exhausted follower's roles unqueued when a scan fans out", async () => {
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [source] = await db.select().from(schema.careerSources);
    const aiDeps = { ...deps, ai: { ...deps.ai, enabled: true } } as unknown as WorkerDeps;
    const scoreTasks = () => db.select().from(schema.tasks).where(eq(schema.tasks.type, "score_job"));
    const budget = (value: number) => db.insert(schema.userSettings).values({ userId: user.id, key: "aiBudgetUsd", value })
      .onConflictDoUpdate({ target: [schema.userSettings.userId, schema.userSettings.key], set: { value } });

    await budget(0);
    // Storing a description re-runs the gate, which scores in its own right, so this counts what
    // the scan itself fans out rather than every score task on the table.
    const before = (await scoreTasks()).length;
    await _scanSourceForTests(aiDeps, company, source!, await deps.settings(), null);
    // The scan still observes and stores everything; only this account's scoring is held back,
    // and no task was queued that could only fail at the hold.
    expect(await scoreTasks()).toHaveLength(before);
    expect((await db.select().from(schema.userJobs).where(eq(schema.userJobs.inTable, true))).length).toBeGreaterThan(0);
    expect((await db.select().from(schema.tasks)).filter((row) => row.status === "failed")).toHaveLength(0);

    await budget(25);
    await _scanSourceForTests(aiDeps, company, source!, await deps.settings(), null);
    expect((await scoreTasks()).length).toBeGreaterThan(before);
    // The views the scan queued say so, so the table reads "scoring" rather than a blank score.
    const queued = await db.select().from(schema.userJobs).where(eq(schema.userJobs.scoreState, "queued"));
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.every((row) => row.scoreStateAt !== null)).toBe(true);
  }, 60_000);

  it("does not score legacy non-matches even when old settings enabled them", async () => {
    await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    // Stored legacy flags cannot re-enable retired near-miss scoring.
    await db.update(schema.userJobs).set({ inTable: false, nearMiss: true });
    const near = await db.select().from(schema.userJobs).where(eq(schema.userJobs.nearMiss, true));
    expect(near.length).toBeGreaterThan(0);
    await db.insert(schema.settings).values({ key: "nearMissDailyCap", value: 1 });
    const scoreJob = vi.fn().mockResolvedValue({ score: 80, verdict: "strong", rationale: "Fixture" });
    const aiDeps = { ...deps, ai: { ...deps.ai, enabled: true, scoreJob } } as unknown as WorkerDeps;
    const task = { payload: { userId: user.id, jobId: near[0]!.jobId } } as never;
    const outcomes = await Promise.all([handleScoreJob(task, aiDeps), handleScoreJob(task, aiDeps), handleScoreJob(task, aiDeps)]);
    expect(scoreJob).not.toHaveBeenCalled();
    expect(outcomes.filter((r) => (r as { skipped?: string }).skipped === "role does not match and is not shortlisted")).toHaveLength(3);
  }, 60_000);
});


describe("HTML extraction completion", () => {
  async function htmlFixture() {
    const [company] = await db.insert(schema.companies).values({ name: "Acme", domain: "acme.example", homepageUrl: "https://www.acme.example" }).returning();
    const [source] = await db.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://www.acme.example/listing" }).returning();
    return { company: company!, source: source! };
  }
  it("accepts a structurally verified first-party empty listing", async () => {
    const [company] = await db.insert(schema.companies).values({ name: "Empty Co", domain: "acme.example", homepageUrl: "https://www.acme.example" }).returning();
    const [source] = await db.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://www.acme.example/jobs" }).returning();
    server.setRoutes({ "www.acme.example": {
      "/robots.txt": { body: "User-agent: *\nAllow: /" },
      "/jobs": { body: '<main><h1>Current job openings</h1><div class="jobs"><div class="jobs__job"><p>Sorry, we don\u2019t have any job openings right now.</p></div></div></main>' },
    } });
    const result = await _scanSourceForTests(deps, company!, source!, await deps.settings(), null);
    expect(result.status).toBe("ok");
    expect(result.postingsFound).toBe(0);
  });
  it("keeps an ambiguous empty result as a parse failure", async () => {
    const [company] = await db.insert(schema.companies).values({ name: "Filtered Co", domain: "acme.example", homepageUrl: "https://www.acme.example" }).returning();
    const [source] = await db.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://www.acme.example/jobs?department=sales" }).returning();
    server.setRoutes({ "www.acme.example": {
      "/robots.txt": { body: "User-agent: *\nAllow: /" },
      "/jobs?department=sales": { body: '<main><div class="jobs-empty">No jobs available.</div></main>' },
    } });
    const result = await _scanSourceForTests(deps, company!, source!, await deps.settings(), null);
    expect(result.status).toBe("failed");
    const [scan] = await db.select().from(schema.scans).where(eq(schema.scans.sourceId, source!.id)).orderBy(desc(schema.scans.startedAt)).limit(1);
    expect(scan!.error).toContain("cannot establish a successful empty scan");
  });
  it("marks model extraction from a truncated DOM as partial", async () => {
    const { company, source } = await htmlFixture();
    const links = Array.from({ length: 900 }, (_, i) => `<article><a href="/vacancy-${i}">${"Long role title ".repeat(8)}${i}</a></article>`).join("");
    server.setRoutes({ "www.acme.example": { "/robots.txt": { body: "User-agent: *\nAllow: /" }, "/listing": { body: `<main>${links}</main>` } } });
    const extractPostings = vi.fn().mockResolvedValue({ postings: [{ title: "Operations Manager", url: "https://www.acme.example/vacancy-1" }], dropped: 0 });
    const modelDeps = { ...deps, ai: { ...deps.ai, enabled: true, extractPostings } } as unknown as WorkerDeps;
    const result = await _scanSourceForTests(modelDeps, company, source, await deps.settings(), null);
    expect(result.status).toBe("partial");
    const [scan] = await db.select().from(schema.scans).where(eq(schema.scans.sourceId, source.id)).orderBy(desc(schema.scans.startedAt)).limit(1);
    expect(scan!.error).toContain("truncated listing representation");
  });
  it("keeps a rendered, model-extracted truncated listing partial and closes nothing", async () => {
    const { company, source } = await htmlFixture();
    await db.insert(schema.jobs).values({ companyId: company.id, sourceId: source.id, title: "Existing role", normalizedTitle: "existing role", url: "https://www.acme.example/old-role", externalKey: "url:https://www.acme.example/old-role" });
    server.setRoutes({ "www.acme.example": { "/robots.txt": { body: "User-agent: *\nAllow: /" }, "/listing": { body: '<main><div id="jobs-app"></div></main>' } } });
    const links = Array.from({ length: 900 }, (_, i) => `<article><a href="/vacancy-${i}">${"Long role title ".repeat(8)}${i}</a></article>`).join("");
    const render = vi.fn(async () => ({ html: `<main>${links}</main>`, finalUrl: "https://www.acme.example/listing", requests: [], status: 200 }));
    const extractPostings = vi.fn().mockResolvedValue({
      postings: [{ title: "Observed role", url: "https://www.acme.example/vacancy-1" }],
      dropped: 0,
      recipe: { version: 1, listItem: "article", title: "a", link: "a" },
    });
    const modelDeps = { ...deps, browser: { render }, ai: { ...deps.ai, enabled: true, extractPostings } } as unknown as WorkerDeps;
    for (let i = 0; i < 2; i++) expect((await _scanSourceForTests(modelDeps, company, source, await deps.settings(), null)).status).toBe("partial");
    const [existing] = await db.select().from(schema.jobs).where(eq(schema.jobs.url, "https://www.acme.example/old-role"));
    expect(existing).toMatchObject({ status: "open", missingScans: 0 });
    const [current] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source.id));
    expect(current!.recipe).toBeNull();
  });
  it("marks a known visible model omission partial and preserves the omitted role", async () => {
    const { company, source } = await htmlFixture();
    const firstHtml = '<main><a href="/vacancy-one">Operations Manager</a><a href="/vacancy-two">Strategy Lead</a></main>';
    server.setRoutes({ "www.acme.example": { "/robots.txt": { body: "User-agent: *\nAllow: /" }, "/listing": { body: firstHtml } } });
    const extractPostings = vi.fn()
      .mockResolvedValueOnce({ postings: [
        { title: "Operations Manager", url: "https://www.acme.example/vacancy-one" },
        { title: "Strategy Lead", url: "https://www.acme.example/vacancy-two" },
      ], dropped: 0 })
      .mockResolvedValueOnce({ postings: [{ title: "Strategy Lead", url: "https://www.acme.example/vacancy-two" }], dropped: 0 });
    const modelDeps = { ...deps, ai: { ...deps.ai, enabled: true, extractPostings } } as unknown as WorkerDeps;
    expect((await _scanSourceForTests(modelDeps, company, source, await deps.settings(), null)).status).toBe("ok");
    server.setRoutes({ "www.acme.example": { "/robots.txt": { body: "User-agent: *\nAllow: /" }, "/listing": { body: firstHtml.replace("</main>", "<!-- changed --></main>") } } });
    expect((await _scanSourceForTests(modelDeps, company, source, await deps.settings(), null)).status).toBe("partial");
    const [omitted] = await db.select().from(schema.jobs).where(eq(schema.jobs.url, "https://www.acme.example/vacancy-one"));
    expect(omitted).toMatchObject({ status: "open", missingScans: 0 });
  });
  it("unions pages and retains only three compressed scan snapshots", async () => {
    const { company, source } = await htmlFixture();
    server.setRoutes({ "www.acme.example": {
      "/robots.txt": { body: "User-agent: *\nAllow: /" },
      "/listing": { body: '<a href="/jobs/one">Operations Manager</a><a rel="next" href="/listing?page=2">Next</a>' },
      "/listing?page=2": { body: '<a href="/jobs/two">Operations Lead</a>' },
    } });
    for (let i = 0; i < 4; i++) {
      const result = await _scanSourceForTests(deps, company, source, await deps.settings(), null);
      expect(result.status).toBe("ok");
      expect(result.postingsFound).toBe(2);
    }
    expect(await db.select().from(schema.jobs)).toHaveLength(2);
    const scans = await db.select().from(schema.scans);
    expect(scans.filter(scan => scan.rawSnapshot !== null)).toHaveLength(3);
    // A fifth scan prunes the one snapshot that aged out, and rewrites no row pruned already.
    const pruned = async () => (await db.execute<{ id: string; xmin: string }>(sql`select id, xmin::text as xmin from scans where source_id = ${source.id} and raw_snapshot is null order by id`)).rows;
    const before = await pruned();
    expect(before).toHaveLength(1);
    await _scanSourceForTests(deps, company, source, await deps.settings(), null);
    const after = await pruned();
    expect(after).toHaveLength(2);
    expect(after.find(row => row.id === before[0]!.id)).toEqual(before[0]);
    expect((await db.select().from(schema.scans)).filter(scan => scan.rawSnapshot !== null)).toHaveLength(3);
  }, 60_000);
  it("never closes roles when a later listing page fails", async () => {
    const { company, source } = await htmlFixture();
    const routes = { "/robots.txt": { body: "User-agent: *\nAllow: /" }, "/listing": { body: '<a href="/jobs/one">Operations Manager</a><a rel="next" href="/listing?page=2">Next</a>' } };
    server.setRoutes({ "www.acme.example": { ...routes, "/listing?page=2": { body: '<a href="/jobs/two">Operations Lead</a>' } } });
    await _scanSourceForTests(deps, company, source, await deps.settings(), null);
    server.setRoutes({ "www.acme.example": { ...routes, "/listing?page=2": { status: 404, body: "Not found" } } });
    for (let i = 0; i < 2; i++) expect((await _scanSourceForTests(deps, company, source, await deps.settings(), null)).status).toBe("partial");
    const jobs = await db.select().from(schema.jobs);
    expect(jobs.every(job => job.status === "open" && job.missingScans === 0)).toBe(true);
  }, 60_000);
  it("reuses verified model extraction on unchanged HTML without another model call", async () => {
    const { company, source } = await htmlFixture();
    server.setRoutes({ "www.acme.example": { "/robots.txt": { body: "User-agent: *\nAllow: /" }, "/listing": { body: '<a href="/vacancy-one">Operations Manager</a>' } } });
    const extractPostings = vi.fn().mockResolvedValue({ postings: [{ title: "Operations Manager", url: "https://www.acme.example/vacancy-one" }], dropped: 0 });
    const modelDeps = { ...deps, ai: { ...deps.ai, enabled: true, extractPostings } } as unknown as WorkerDeps;
    expect((await _scanSourceForTests(modelDeps, company, source, await deps.settings(), null)).status).toBe("ok");
    expect((await _scanSourceForTests(deps, company, source, await deps.settings(), null)).status).toBe("ok");
    expect(extractPostings).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.jobs)).toHaveLength(1);
  }, 60_000);
  it("does not overwrite a manually edited reason tag", async () => {
    const { company, source } = await htmlFixture();
    const [job] = await db.insert(schema.jobs).values({ companyId: company.id, sourceId: source.id, title: "Operations", normalizedTitle: "operations", url: "https://www.acme.example/jobs/1", externalKey: "one" }).returning();
    const [decision] = await db.insert(schema.decisions).values({ userId: user.id, jobId: job!.id, decision: "skip", reason: "Too junior", jobTitle: "Operations", companyName: "Acme", tags: [], tagsEdited: true }).returning();
    const tagReason = vi.fn();
    const modelDeps = { ...deps, ai: { ...deps.ai, enabled: true, tagReason } } as unknown as WorkerDeps;
    await handleTagReason({ payload: { decisionId: decision!.id } } as never, modelDeps);
    expect(tagReason).not.toHaveBeenCalled();
  });
});

it("re-discovers a source whose listing collapses and stays collapsed, without closing roles", async () => {
  await setGate({});
  const filler = Array.from({ length: 12 }, (_, i) => ({
    ...JOB_ENGINEER, id: 6_000_000 + i, title: `Engineer ${i}`, absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${6_000_000 + i}`,
  }));
  setJobs([JOB_OPERATIONS_MANAGER, ...filler]);
  const company = await addCompany("https://www.acme.example/", "acme.example");
  await queue.drain();

  // The old board keeps serving a shrinking remainder after a migration; the
  // roles we know about are not in it.
  const scanAt = async (day: string, remainder: number) => {
    setJobs(filler.slice(0, remainder));
    now = new Date(`${day}T06:00:00Z`);
    await enqueueTask(db, "scan_company", { companyId: company.id, trigger: "manual" }, { dedupeKey: dedupeKeyFor("scan_company", { companyId: company.id }), priority: 5 });
    await queue.drain();
  };
  await scanAt("2026-09-06", 3);
  await scanAt("2026-09-07", 2);
  let discovers = await db.select().from(schema.tasks).where(sql`type = 'discover' and payload->>'reason' = 'shrunk'`);
  expect(discovers).toHaveLength(0);
  await scanAt("2026-09-08", 1);
  discovers = await db.select().from(schema.tasks).where(sql`type = 'discover' and payload->>'reason' = 'shrunk'`);
  expect(discovers.length).toBeGreaterThanOrEqual(1);
  const scans = await db.select().from(schema.scans).orderBy(schema.scans.startedAt);
  expect(scans.slice(-3).every(scan => scan.status === "partial" && /shrank/.test(scan.error ?? ""))).toBe(true);
  const manager = (await jobsInTable()).find(r => r.title === "Operations Manager")!;
  expect(manager.status).toBe("open");
  expect(manager.missingScans).toBe(0);
}, 120_000);

it("takes a collapsed count read three times running as the board's size, and looks for a new board", async () => {
  await setGate({});
  const filler = Array.from({ length: 12 }, (_, i) => ({
    ...JOB_ENGINEER, id: 6_100_000 + i, title: `Engineer ${i}`, absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${6_100_000 + i}`,
  }));
  setJobs([JOB_OPERATIONS_MANAGER, ...filler]);
  const company = await addCompany("https://www.acme.example/", "acme.example");
  await queue.drain();
  const [source] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, company.id));
  setJobs(filler.slice(0, 3));
  const scanOn = async (day: string) => {
    now = new Date(`${day}T06:00:00Z`);
    const [current] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source!.id));
    return _scanSourceForTests(deps, company, current!, await deps.settings(), null);
  };
  expect((await scanOn("2026-09-06")).status).toBe("partial");
  expect((await scanOn("2026-09-07")).status).toBe("partial");
  // The third identical reading: the board shrank, and a board that shrank must be able to close roles.
  expect((await scanOn("2026-09-08")).status).toBe("ok");
  const manager = (await jobsInTable()).find(r => r.title === "Operations Manager")!;
  expect(manager).toMatchObject({ status: "open", missingScans: 1 });
  expect(await db.select().from(schema.tasks).where(sql`type = 'discover' and payload->>'reason' = 'shrunk'`)).toHaveLength(1);
  // Judged against its new size from here: the next reading is ok and closes what it lacks.
  const next = await scanOn("2026-09-09");
  expect(next.status).toBe("ok");
  expect(next.closedCount).toBeGreaterThan(0);
}, 120_000);

it("backs a failing source off to the next daily run, not the one after", async () => {
  await setGate({});
  const company = await addCompany("https://www.acme.example/", "acme.example");
  await queue.drain();
  const [source] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, company.id));
  server.setRoutes({ "www.acme.example": acmeRoutes(), "acme.example": acmeRoutes(), "job-boards.greenhouse.io": {},
    "boards-api.greenhouse.io": { "/v1/boards/acme/jobs": { status: 500, body: { error: "boom" } } } });
  // The scheduled run starts at 06:00; this source's turn comes forty minutes in, and it fails.
  now = new Date("2026-09-06T06:40:00Z");
  expect((await _scanSourceForTests(deps, company, source!, await deps.settings(), null)).status).toBe("failed");
  const [failed] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source!.id));
  expect(failed!.consecutiveFailures).toBe(1);
  // Tomorrow's 06:00 run finds it due.
  now = new Date("2026-09-07T06:00:00Z");
  await handleRunDaily({ payload: { trigger: "schedule", runDate: "2026-09-07" } } as never, deps);
  const [run] = await db.select().from(schema.scanRuns).where(eq(schema.scanRuns.runDate, "2026-09-07"));
  expect(run!.companiesTotal).toBe(1);
}, 60_000);

it("marks a listing that reaches the adapter cap partial and never closes roles from it", async () => {
  await setGate({});
  setJobs([JOB_OPERATIONS_MANAGER, JOB_ENGINEER]);
  const company = await addCompany("https://www.acme.example/", "acme.example");
  await queue.drain();
  expect((await jobsInTable()).map(r => r.title)).toContain("Operations Manager");

  // The board grows to the cap and the Operations Manager posting is not in
  // what we read. A complete listing would close it after two misses; a capped
  // one is not evidence of anything.
  const filler = Array.from({ length: ats.MAX_POSTINGS }, (_, i) => ({
    ...JOB_ENGINEER, id: 5_000_000 + i, title: `Engineer ${i}`, absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${5_000_000 + i}`,
  }));
  setJobs(filler);
  for (const day of ["2026-09-06", "2026-09-07"]) {
    now = new Date(`${day}T06:00:00Z`);
    await enqueueTask(db, "scan_company", { companyId: company.id, trigger: "manual" }, { dedupeKey: dedupeKeyFor("scan_company", { companyId: company.id }), priority: 5 });
    await queue.drain();
  }
  const scans = await db.select().from(schema.scans).orderBy(schema.scans.startedAt);
  expect(scans.at(-1)?.status).toBe("partial");
  expect(scans.at(-1)?.error).toMatch(/cap/);
  expect(scans.at(-1)?.postingsFound).toBe(ats.MAX_POSTINGS);
  const manager = (await jobsInTable()).find(r => r.title === "Operations Manager")!;
  expect(manager.status).toBe("open");
  expect(manager.missingScans).toBe(0);
}, 120_000);

it("files role-type and seniority suggestions from the latest scan evidence", async () => {
  await setGate({ includeKeywords: ["Operations"], seniorityKeywords: ["Director", "VP"], locationTerms: ["London", "UK"] });
  const london = (id: number, title: string) => ({ ...JOB_ENGINEER, id, title, absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`, location: { name: "London, UK" } });
  setJobs([
    JOB_OPERATIONS_MANAGER,
    london(7_000_001, "Operations Lead"), london(7_000_002, "Business Operations Lead"), london(7_000_003, "Lead, Operations Enablement"),
    london(7_000_004, "Director of Partnerships"), london(7_000_005, "VP Partnerships"), london(7_000_006, "Director, Partnership Development"),
  ]);
  await addCompany("https://www.acme.example/", "acme.example");
  await queue.drain();
  await enqueueTask(db, "suggest_from_scans", { userId: user.id }, { dedupeKey: dedupeKeyFor("suggest_from_scans", { userId: user.id }), priority: 6 });
  await queue.drain();
  const rows = await db.select().from(schema.filterSuggestions).where(eq(schema.filterSuggestions.status, "pending"));
  const byTerm = new Map(rows.map(r => [`${r.type}:${(r.value as { term: string }).term}`, r]));
  expect(byTerm.has("seniority_include:Lead")).toBe(true);
  expect(byTerm.get("seniority_include:Lead")!.rationale).toMatch(/3 roles/);
  expect(byTerm.has("keyword_include:partnership*")).toBe(true);
  expect((byTerm.get("keyword_include:partnership*")!.evidence as Array<{ title: string }>).map(e => e.title)).toContain("Director of Partnerships");
  // A second run files nothing new while those are pending.
  await enqueueTask(db, "suggest_from_scans", { userId: user.id }, { dedupeKey: dedupeKeyFor("suggest_from_scans", { userId: user.id }), priority: 6 });
  await queue.drain();
  expect(await db.select().from(schema.filterSuggestions)).toHaveLength(rows.length);
}, 120_000);

it("reuses the last browser render while a load-more listing's first page is unchanged", async () => {
  const [company] = await db.insert(schema.companies).values({ name: "Acme", domain: "acme.example", homepageUrl: "https://www.acme.example" }).returning();
  const [source] = await db.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://www.acme.example/listing" }).returning();
  const page = '<a href="/jobs/one">Operations Manager</a><button>Load more</button>';
  server.setRoutes({ "www.acme.example": { "/robots.txt": { body: "User-agent: *\nAllow: /" }, "/listing": { body: page } } });
  const render = vi.fn(async () => ({ html: '<a href="/jobs/one">Operations Manager</a><a href="/jobs/two">Operations Lead</a>', finalUrl: "https://www.acme.example/listing", requests: [], status: 200 }));
  const withBrowser = { ...deps, browser: { render } as unknown as WorkerDeps["browser"] };
  const scan = async () => _scanSourceForTests(withBrowser, company!, source!, await deps.settings(), null);

  expect((await scan()).postingsFound).toBe(2);
  expect(render).toHaveBeenCalledTimes(1);
  now = new Date(now.getTime() + 86_400_000);
  expect((await scan()).postingsFound).toBe(2);
  expect(render).toHaveBeenCalledTimes(1); // same first page: capture reused, no render
  server.setRoutes({ "www.acme.example": { "/robots.txt": { body: "User-agent: *\nAllow: /" }, "/listing": { body: page.replace("Manager", "Manager (Hybrid)") } } });
  now = new Date(now.getTime() + 86_400_000);
  await scan();
  expect(render).toHaveBeenCalledTimes(2); // first page changed: render again
  now = new Date(now.getTime() + 8 * 86_400_000);
  await scan();
  expect(render).toHaveBeenCalledTimes(3); // a week on, refresh regardless
}, 120_000);

it("discards a late scan when its source has been disabled", async () => {
  await setGate({});
  const company = await addCompany("https://www.acme.example/", "acme.example");
  await queue.drain();
  const [source] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, company.id));
  const before = await db.select().from(schema.jobs);
  await db.update(schema.careerSources).set({ status: "disabled" }).where(eq(schema.careerSources.id, source!.id));
  setJobs([]);
  const outcome = await _scanSourceForTests(deps, company, source!, await deps.settings(), null);
  expect(outcome.status).toBe("partial");
  expect((await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source!.id)))[0]!.status).toBe("disabled");
  expect(await db.select().from(schema.jobs)).toEqual(before);
});

it("fences company profile replacement and retains previous evidence on lost ownership", async () => {
  const { handleProfileCompany } = await import("./handlers/companies");
  const company = await addCompany("https://www.acme.example/", "acme.example");
  await db.insert(schema.companyProfiles).values({ companyId: company.id, name: company.name, domain: company.domain, sector: "Previous sector" });
  const fakeAi = { enabled: true, profileCompany: async () => ({ oneLiner: "Updated profile", sector: "New sector" }) } as unknown as WorkerDeps["ai"];
  const lost = { ...deps, ai: fakeAi, assertOwnership: async () => { throw new Error("lease lost"); } };
  await expect(handleProfileCompany({ payload: { companyId: company.id } } as unknown as import("@ava/db").Task, lost)).rejects.toThrow("lease lost");
  expect((await db.select().from(schema.companyProfiles))[0]!.sector).toBe("Previous sector");
  await handleProfileCompany({ payload: { companyId: company.id } } as unknown as import("@ava/db").Task, { ...deps, ai: fakeAi });
  const profiles = await db.select().from(schema.companyProfiles);
  expect(profiles).toHaveLength(1); expect(profiles[0]!.sector).toBe("New sector");
});

describe("shared catalogue", () => {
  it("scans a company once a day for every follower and gates the listing per account", async () => {
    await setGate({ locationTerms: ["UK"] });
    const engineer = await ensureTestUser(db, "engineer@example.com", "member");
    await db.insert(schema.userSettings).values({ userId: engineer.id, key: "gate", value: { includeKeywords: ["engineer"], excludeKeywords: [], matchFields: ["title"], locationTerms: [], includeRemote: true } });
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await subscribeToCompany(db, engineer.id, company.id);
    await queue.drain();

    // One discovery, one scan, one shared listing.
    expect(await db.select().from(schema.scans)).toHaveLength(1);
    expect(await db.select().from(schema.jobs)).toHaveLength(5);
    expect((await jobsInTable()).map(r => r.title)).toEqual(["Operations Analyst", "Operations Manager"]);
    expect((await jobsInTable(engineer)).map(r => r.title)).toEqual(["Software Engineer, Platform"]);
    // Each account's view is its own: three rows in all, none shared.
    const views = await db.select().from(schema.userJobs);
    expect(views.filter(v => v.userId === user.id)).toHaveLength(2);
    expect(views.filter(v => v.userId === engineer.id)).toHaveLength(1);

    // The daily run covers the company once however many people follow it.
    await enqueueTask(db, "run_daily", { trigger: "manual" }, { dedupeKey: null, priority: 5 });
    await queue.drain();
    const [run] = await db.select().from(schema.scanRuns).orderBy(desc(schema.scanRuns.startedAt)).limit(1);
    expect(run!.companiesTotal).toBe(1);
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.type, "scan_company"))).filter(t => (t.payload as { scanRunId?: string }).scanRunId === run!.id)).toHaveLength(1);

    // A second follower's "rescan now" minutes later is served by the scan just made.
    now = new Date(now.getTime() + 5 * 60_000);
    await enqueueTask(db, "scan_company", { companyId: company.id, trigger: "manual" }, { dedupeKey: dedupeKeyFor("scan_company", { companyId: company.id }), priority: 5 });
    await queue.drain();
    const scans = await db.select().from(schema.scans);
    expect(scans).toHaveLength(2);
    const [manual] = await db.select().from(schema.tasks).where(sql`type = 'scan_company' and payload->>'trigger' = 'manual' and payload->>'scanRunId' is null`).orderBy(desc(schema.tasks.createdAt)).limit(1);
    expect(manual!.result).toMatchObject({ skipped: "scanned recently" });

    // Pausing one follower leaves the company active for the other; unfollowing everyone retires it.
    const { setSubscriptionStatus } = await import("@ava/db");
    await setSubscriptionStatus(db, user.id, company.id, "paused");
    expect((await db.select().from(schema.companies).where(eq(schema.companies.id, company.id)))[0]!.status).toBe("active");
    await setSubscriptionStatus(db, engineer.id, company.id, "archived");
    expect((await db.select().from(schema.companies).where(eq(schema.companies.id, company.id)))[0]!.status).toBe("paused");
    await setSubscriptionStatus(db, user.id, company.id, "archived");
    expect((await db.select().from(schema.companies).where(eq(schema.companies.id, company.id)))[0]!.status).toBe("archived");
  }, 120_000);

  it("gives a new follower of an already tracked company its matching roles without another scan", async () => {
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const late = await ensureTestUser(db, "late@example.com", "member");
    await db.insert(schema.userSettings).values({ userId: late.id, key: "gate", value: { includeKeywords: ["engineer"], excludeKeywords: [], matchFields: ["title"], locationTerms: [], includeRemote: true } });
    await subscribeToCompany(db, late.id, company.id);
    const outcome = await reevaluateGate(db, late.id, await deps.userSettings(late.id), now, { companyId: company.id });
    expect(outcome.created).toBe(1);
    const rows = await jobsInTable(late);
    expect(rows.map(r => r.title)).toEqual(["Software Engineer, Platform"]);
    // The posting was already known to the scan, so it is seeded for this account rather than news.
    expect(rows[0]!.seeded).toBe(true);
    expect(await db.select().from(schema.scans)).toHaveLength(1);
  }, 60_000);

  it("widens and narrows one account's gate over the stored listing, leaving the other account alone", async () => {
    // The catalogue is shared and the table is per account: changing one gate must move that
    // account's rows only, and must never need the company scanned again.
    await setGate({});
    const engineer = await ensureTestUser(db, "widen@example.com", "member");
    const setEngineerGate = async (includeKeywords: string[]) => {
      const value = { includeKeywords, excludeKeywords: [], matchFields: ["title"], locationTerms: [], includeRemote: true };
      await db.insert(schema.userSettings).values({ userId: engineer.id, key: "gate", value })
        .onConflictDoUpdate({ target: [schema.userSettings.userId, schema.userSettings.key], set: { value } });
      deps.invalidateSettings();
    };
    await setEngineerGate(["engineer"]);
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await subscribeToCompany(db, engineer.id, company.id);
    await queue.drain();

    // One scan, one shared listing, two different tables.
    expect(await db.select().from(schema.scans)).toHaveLength(1);
    expect(await db.select().from(schema.jobs)).toHaveLength(5);
    expect((await jobsInTable()).map(r => r.title)).toEqual(["Head of Business Operations", "Operations Analyst", "Operations Manager", "Senior Operations Associate"]);
    expect((await jobsInTable(engineer)).map(r => r.title)).toEqual(["Software Engineer, Platform"]);

    // Widening admits postings the scan already stored, with no second scan.
    await setEngineerGate(["engineer", "operations"]);
    await reevaluateGate(db, engineer.id, await deps.userSettings(engineer.id), now);
    expect((await jobsInTable(engineer)).filter(r => r.inTable)).toHaveLength(5);
    expect(await db.select().from(schema.scans)).toHaveLength(1);

    // Narrowing archives this account's non-matches, except the two it has invested in.
    const engineerRows = await jobsInTable(engineer);
    const decided = engineerRows.find(r => r.title === "Operations Manager")!;
    const withCv = engineerRows.find(r => r.title === "Operations Analyst")!;
    await db.insert(schema.decisions).values({ userId: engineer.id, jobId: decided.jobId, decision: "apply", jobTitle: decided.title, companyName: "Acme" });
    await db.insert(schema.cvDrafts).values({ userId: engineer.id, jobId: withCv.jobId, jobTitle: withCv.title, companyName: "Acme", jobDescription: "Role", libraryVersion: 1, librarySnapshot: { name: "Test", contact: "", profile: "", entries: [] }, model: "fixture" });
    await setEngineerGate(["engineer"]);
    await reevaluateGate(db, engineer.id, await deps.userSettings(engineer.id), now);

    const views = await db.select().from(schema.userJobs).where(eq(schema.userJobs.userId, engineer.id));
    const archived = new Set(views.filter(v => v.archivedAt).map(v => v.jobId));
    expect(archived.has(decided.jobId)).toBe(false);
    expect(archived.has(withCv.jobId)).toBe(false);
    expect(archived.size).toBe(2);
    // The other account is untouched throughout: same rows, none archived.
    const mine = await db.select().from(schema.userJobs).where(eq(schema.userJobs.userId, user.id));
    expect(mine).toHaveLength(4);
    expect(mine.every(v => v.inTable && v.archivedAt === null)).toBe(true);
    expect(await db.select().from(schema.scans)).toHaveLength(1);

    // Widening again brings back what the gate put away, and only that: the role the person
    // archived by hand stays where they put it.
    const engineerRole = engineerRows.find(r => r.title === "Software Engineer, Platform")!;
    await db.update(schema.userJobs).set({ archivedAt: new Date(now.getTime() + 60_000) })
      .where(and(eq(schema.userJobs.userId, engineer.id), eq(schema.userJobs.jobId, engineerRole.jobId)));
    await setEngineerGate(["engineer", "operations"]);
    await reevaluateGate(db, engineer.id, await deps.userSettings(engineer.id), now);
    const rewidened = await db.select().from(schema.userJobs).where(eq(schema.userJobs.userId, engineer.id));
    expect(rewidened.every(v => v.inTable)).toBe(true);
    for (const jobId of archived) expect(rewidened.find(v => v.jobId === jobId)).toMatchObject({ archivedAt: null, gateArchivedAt: null });
    expect(rewidened.find(v => v.jobId === engineerRole.jobId)!.archivedAt).not.toBeNull();
    expect(rewidened.filter(v => v.archivedAt !== null)).toHaveLength(1);
    const restoredEvents = await db.select().from(schema.jobEvents)
      .where(and(eq(schema.jobEvents.userId, engineer.id), sql`${schema.jobEvents.payload}->>'action' = 'unarchived'`));
    expect(restoredEvents.map(e => e.jobId).sort()).toEqual([...archived].sort());
  }, 120_000);

  it("writes its verdicts from the gate saved while it was fetching, not the one it started with", async () => {
    // A person widens their keywords while a scan of a company they follow is reading the board.
    // The save re-evaluates their gate at once; the scan must not then commit verdicts from the
    // gate it read before its network work and archive the roles that were just admitted.
    await setGate({ includeKeywords: ["engineer"] });
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    expect((await jobsInTable()).map(r => r.title)).toEqual(["Software Engineer, Platform"]);
    const [source] = await db.select().from(schema.careerSources);

    const racing: WorkerDeps = { ...deps, assertOwnership: async () => {
      await setGate({ includeKeywords: ["engineer", "operations"] });
      deps.invalidateSettings();
      await reevaluateGate(db, user.id, await deps.userSettings(user.id), now);
    } };
    now = new Date(now.getTime() + 86_400_000);
    const outcome = await _scanSourceForTests(racing, company, source!, await deps.settings(), null);
    expect(outcome.status).toBe("ok");

    const views = await db.select().from(schema.userJobs).where(eq(schema.userJobs.userId, user.id));
    expect(views).toHaveLength(5);
    expect(views.every(v => v.inTable && v.archivedAt === null)).toBe(true);
  }, 60_000);

  it("keeps a description a fetch_description stored while the scan was in flight", async () => {
    // The scan reads every stored description before it opens its transaction. A description task
    // that commits in that window must not be written back to null by the scan's refresh.
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [source] = await db.select().from(schema.careerSources);

    // A feed that stops supplying descriptions, and a posting that has none stored yet.
    setJobs([{ ...JOB_OPERATIONS_MANAGER, content: undefined }, JOB_ENGINEER, JOB_OPS_NEW_YORK, JOB_OPS_REMOTE_US, JOB_OPS_REMOTE_UK]);
    const [target] = await db.select().from(schema.jobs).where(eq(schema.jobs.externalKey, "id:4001001"));
    await db.update(schema.jobs).set({ descriptionText: null, descriptionHash: null, descriptionFetchedAt: null }).where(eq(schema.jobs.id, target!.id));

    // `assertOwnership` runs as the scan's transaction opens, which is exactly the window a
    // concurrent fetch_description commits in.
    const text = "Own operations for our London site, written by the description task.";
    const racing: WorkerDeps = { ...deps, assertOwnership: async () => {
      await db.update(schema.jobs).set({ descriptionText: text, descriptionHash: sha1(text), descriptionFetchedAt: new Date(now.getTime() + 1000) }).where(eq(schema.jobs.id, target!.id));
    } };
    const outcome = await _scanSourceForTests(racing, company, source!, await deps.settings(), null);
    expect(outcome.status).toBe("ok");

    const [after] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, target!.id));
    expect(after!.descriptionText).toBe(text);
    expect(after!.descriptionHash).toBe(sha1(text));
  }, 60_000);
});

describe("what a scan costs the host", () => {
  /** A route that answers a matching `If-None-Match` with 304 and nothing else. */
  function etagged(body: object, tag: string) {
    return (req: import("node:http").IncomingMessage) =>
      req.headers["if-none-match"] === tag ? { status: 304, body: "", headers: { etag: tag } } : { body, headers: { etag: tag } };
  }

  async function latestScan(sourceId: string) {
    const [scan] = await db.select().from(schema.scans).where(eq(schema.scans.sourceId, sourceId)).orderBy(desc(schema.scans.startedAt)).limit(1);
    return scan!;
  }

  it("counts its requests and charges no bytes for a listing served from revalidation", async () => {
    await setGate({});
    server.setRoutes({
      "www.acme.example": acmeRoutes(),
      "acme.example": acmeRoutes(),
      "job-boards.greenhouse.io": {},
      "boards-api.greenhouse.io": {
        "/v1/boards/acme/jobs": etagged({ jobs: [{ ...JOB_OPERATIONS_MANAGER, content: undefined }], meta: { total: 1 } }, "listing-1"),
        "/v1/boards/acme/departments": etagged({ departments: [] }, "departments-1"),
        "/v1/boards/acme/offices": etagged({ offices: [] }, "offices-1"),
      },
    });
    // No discovery: discovery reads the same board, and its response would already be in the
    // fetcher's cache, so the first scan would revalidate too and prove nothing.
    const [company] = await db.insert(schema.companies).values({ name: "Acme Robotics", domain: "acme.example", homepageUrl: "https://www.acme.example/" }).returning();
    await subscribeToCompany(db, user.id, company!.id);
    const [source] = await db.insert(schema.careerSources).values({
      companyId: company!.id, type: "greenhouse", url: "https://boards.greenhouse.io/acme",
      apiUrl: "https://boards-api.greenhouse.io/v1/boards/acme/jobs", atsSlug: "acme", confidence: 0.95,
    }).returning();

    await _scanSourceForTests(deps, company!, source!, await deps.settings(), null);
    const first = await latestScan(source!.id);
    expect(first.status).toBe("ok");
    // The listing plus the department and office indexes: three requests, all transferred.
    expect(first.requests).toBe(3);
    expect(first.revalidated).toBe(0);
    expect(first.fetchedBytes).toBeGreaterThan(0);

    // The next day, with nothing changed on the board: the same three requests, no transfer.
    now = new Date(now.getTime() + 86_400_000);
    const [again] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source!.id));
    await _scanSourceForTests(deps, company!, again!, await deps.settings(), null);
    const second = await latestScan(source!.id);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("ok");
    expect(second.requests).toBe(3);
    expect(second.revalidated).toBe(3);
    expect(second.fetchedBytes).toBe(0);
  }, 60_000);

  it("treats a rate-limited board as a failed scan, not a blocked source", async () => {
    // One transient 429 used to mark the source `blocked`, which nothing but a person clears: the
    // company then stopped being scanned for ever. It is a back-off - this scan fails and the next
    // one succeeds.
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [source] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, company.id));
    const before = await jobsInTable();
    expect(before.length).toBeGreaterThan(0);

    const jobs = [JOB_OPERATIONS_MANAGER, JOB_ENGINEER, JOB_OPS_NEW_YORK, JOB_OPS_REMOTE_US, JOB_OPS_REMOTE_UK];
    server.setRoutes({
      "www.acme.example": acmeRoutes(), "acme.example": acmeRoutes(), "job-boards.greenhouse.io": {},
      "boards-api.greenhouse.io": { ...greenhouseRoutes(jobs), "/v1/boards/acme/jobs": { status: 429, body: "slow down", headers: { "retry-after": "1" } } },
    });
    now = new Date(now.getTime() + 86_400_000);
    const [current] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source!.id));
    const outcome = await _scanSourceForTests(deps, company, current!, await deps.settings(), null);
    expect(outcome.status).toBe("failed");
    const limited = await latestScan(source!.id);
    expect(limited.status).toBe("failed");
    expect(limited.error).toContain("rate limited (429)");
    const [afterLimit] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source!.id));
    expect(afterLimit!.status).toBe("active");
    expect(afterLimit!.consecutiveFailures).toBe(1);
    // A failed scan is not evidence that anything has gone: no role moved.
    expect(await jobsInTable()).toEqual(before);

    // The next day, with the burst over. The 429 left a back-off in `host_pacing` that a new day
    // is long past.
    await db.execute(sql`delete from host_pacing`);
    setJobs(jobs);
    now = new Date(now.getTime() + 86_400_000);
    await _scanSourceForTests(deps, company, afterLimit!, await deps.settings(), null);
    const recovered = await latestScan(source!.id);
    expect(recovered.status).toBe("ok");
    const [healthy] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source!.id));
    expect(healthy!.status).toBe("active");
    expect(healthy!.consecutiveFailures).toBe(0);
    expect(healthy!.nextScanAt).toBeNull();
  }, 60_000);
});

describe("what a scan asks for and when", () => {
  async function latestScan(sourceId: string) {
    const [scan] = await db.select().from(schema.scans).where(eq(schema.scans.sourceId, sourceId)).orderBy(desc(schema.scans.startedAt)).limit(1);
    return scan!;
  }
  async function currentSource(sourceId: string) {
    const [source] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, sourceId));
    return source!;
  }

  it("re-reads a description when the board says the role moved, not once a fortnight", async () => {
    // Greenhouse publishes `updated_at` per role. Re-reading a stored description every fourteen
    // days to find out what `updated_at` already answers is one detail fetch per role per fortnight
    // — across a catalogue of boards, most of a day's outbound requests, for text that has not moved.
    await setGate({});
    setJobs([JOB_OPERATIONS_MANAGER, JOB_ENGINEER, JOB_OPS_NEW_YORK]);
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [source] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, company.id));
    const [manager] = await db.select().from(schema.jobs).where(eq(schema.jobs.externalKey, `id:${JOB_OPERATIONS_MANAGER.id}`));
    expect(manager!.descriptionText).toBeTruthy();
    expect(manager!.descriptionFetchedAt).toBeInstanceOf(Date);

    // A fortnight and a day later, with every `updated_at` where it was.
    await db.delete(schema.tasks);
    now = new Date(now.getTime() + 15 * 86_400_000);
    const settings = await deps.settings();
    expect((await _scanSourceForTests(deps, company, await currentSource(source!.id), settings, null)).status).toBe("ok");
    expect(await db.select().from(schema.tasks).where(eq(schema.tasks.type, "fetch_description"))).toHaveLength(0);

    // The board edits one role. That, and only that, is what re-reads a description.
    setJobs([{ ...JOB_OPERATIONS_MANAGER, updated_at: "2026-09-19T09:00:00Z" }, JOB_ENGINEER, JOB_OPS_NEW_YORK]);
    await _scanSourceForTests(deps, company, await currentSource(source!.id), settings, null);
    const queued = await db.select().from(schema.tasks).where(eq(schema.tasks.type, "fetch_description"));
    expect(queued).toHaveLength(1);
    expect((queued[0]!.payload as { jobId: string }).jobId).toBe(manager!.id);
  }, 120_000);

  it("keeps the fortnightly refresh for a feed that carries no updated_at", async () => {
    // SmartRecruiters publishes no `updated_at`, so age is all there is to go on and the old rule
    // stands: the saving above is taken only where the vendor answers the question for us.
    await setGate({});
    server.setRoutes({ "api.smartrecruiters.com": smartRecruitersRoutes("small") });
    const [company] = await db.insert(schema.companies).values({ name: "Orbital", domain: "orbital.example", homepageUrl: "https://www.orbital.example/" }).returning();
    await subscribeToCompany(db, user.id, company!.id);
    const [source] = await db.insert(schema.careerSources).values({
      companyId: company!.id, type: "smartrecruiters", url: "https://jobs.smartrecruiters.com/orbital",
      apiUrl: "https://api.smartrecruiters.com/v1/companies/orbital/postings", atsSlug: "orbital", status: "active",
    }).returning();
    const settings = await deps.settings();
    await _scanSourceForTests(deps, company!, source!, settings, null);
    await queue.drain();
    const stored = await db.select().from(schema.jobs);
    expect(stored).toHaveLength(3);
    expect(stored.every(job => job.descriptionFetchedAt !== null)).toBe(true);

    await db.delete(schema.tasks);
    await _scanSourceForTests(deps, company!, await currentSource(source!.id), settings, null);
    expect(await db.select().from(schema.tasks).where(eq(schema.tasks.type, "fetch_description"))).toHaveLength(0);
    now = new Date(now.getTime() + 15 * 86_400_000);
    await _scanSourceForTests(deps, company!, await currentSource(source!.id), settings, null);
    expect(await db.select().from(schema.tasks).where(eq(schema.tasks.type, "fetch_description"))).toHaveLength(3);
  }, 120_000);

  it("reuses the listing behind an unchanged large board, and still needs two misses to close", async () => {
    // A listing over the cache's per-entry limit was re-downloaded and re-parsed every day because
    // nothing was kept to revalidate it with. The reuse below is only ever the same bytes read
    // again: an unchanged board lists every role it listed yesterday, so nothing is missing from
    // it, nothing closes on it that a re-parse would not have closed, and two consecutive
    // successful misses are still what closes a role.
    await setGate({});
    const filler = (n: number) => ({
      id: 5_000_000 + n, title: `Systems Technician ${n}`, updated_at: "2026-08-01T09:00:00Z",
      absolute_url: `https://job-boards.greenhouse.io/acme-big/jobs/${5_000_000 + n}`,
      location: { name: "London, UK" }, requisition_id: `REQ-${n}-${"x".repeat(600)}`,
    });
    const listed: Array<Record<string, unknown>> = [JOB_OPERATIONS_MANAGER, JOB_OPS_NEW_YORK, ...Array.from({ length: 900 }, (_, i) => filler(i))];
    let etag = "board-1";
    let jobs = listed;
    server.setRoutes({ "job-boards.greenhouse.io": {}, "boards-api.greenhouse.io": {
      "/v1/boards/acme-big/jobs": (req: import("node:http").IncomingMessage) => {
        const listing = jobs.map(({ content: _content, ...rest }) => rest);
        return req.headers["if-none-match"] === etag
          ? { status: 304, body: "", headers: { etag } }
          : { body: { jobs: listing, meta: { total: listing.length } }, headers: { etag } };
      },
      "/v1/boards/acme-big": { body: { name: "Acme Robotics" } },
    } });
    const [company] = await db.insert(schema.companies).values({ name: "Acme Robotics", domain: "acme.example", homepageUrl: "https://www.acme.example/" }).returning();
    await subscribeToCompany(db, user.id, company!.id);
    const [created] = await db.insert(schema.careerSources).values({
      companyId: company!.id, type: "greenhouse", url: "https://job-boards.greenhouse.io/acme-big",
      apiUrl: "https://boards-api.greenhouse.io/v1/boards/acme-big/jobs", atsSlug: "acme-big", status: "active",
    }).returning();
    const settings = await deps.settings();
    const scan = async () => _scanSourceForTests(deps, company!, await currentSource(created!.id), settings, null);

    expect((await scan()).status).toBe("ok");
    const first = await latestScan(created!.id);
    expect(first.postingsFound).toBe(902);
    // Over the 512 KB the revalidation cache will hold, which is the whole point of this path.
    expect(first.fetchedBytes).toBeGreaterThan(512 * 1024);
    expect(first.revalidated).toBe(0);

    // The next day, with the board untouched.
    now = new Date(now.getTime() + 86_400_000);
    expect((await scan()).status).toBe("ok");
    const second = await latestScan(created!.id);
    expect(second.postingsFound).toBe(902);
    expect(second.requests).toBe(1);
    expect(second.revalidated).toBe(1);
    expect(second.fetchedBytes).toBe(0);
    expect(second.closedCount).toBe(0);
    const afterReuse = await db.select().from(schema.jobs);
    expect(afterReuse).toHaveLength(902);
    // Every stored role was in the reused listing, so none of them even counts as missing.
    expect(afterReuse.every(job => job.status === "open" && job.missingScans === 0)).toBe(true);

    // With nothing to reuse — pruned, unreadable, or written by a scan of some other listing — the
    // scan asks again without the validators rather than inventing an observation.
    await db.update(schema.scans).set({ rawSnapshot: null }).where(eq(schema.scans.sourceId, created!.id));
    now = new Date(now.getTime() + 86_400_000);
    expect((await scan()).status).toBe("ok");
    const refetched = await latestScan(created!.id);
    expect(refetched.postingsFound).toBe(902);
    expect(refetched.requests).toBe(4);
    expect(refetched.revalidated).toBe(1);
    expect(refetched.fetchedBytes).toBeGreaterThan(512 * 1024);

    // The board takes a role down and its validator moves with it: a full read, one miss.
    jobs = listed.filter(job => job.id !== JOB_OPERATIONS_MANAGER.id);
    etag = "board-2";
    now = new Date(now.getTime() + 86_400_000);
    expect((await scan()).status).toBe("ok");
    const third = await latestScan(created!.id);
    expect(third.fetchedBytes).toBeGreaterThan(512 * 1024);
    expect(third.closedCount).toBe(0);
    const [missedOnce] = await db.select().from(schema.jobs).where(eq(schema.jobs.externalKey, `id:${JOB_OPERATIONS_MANAGER.id}`));
    expect(missedOnce!.status).toBe("open");
    expect(missedOnce!.missingScans).toBe(1);

    // The day after that the board is unchanged again, so this scan is served from the snapshot
    // the shortened listing wrote. The second miss is a real one and the role closes on it.
    now = new Date(now.getTime() + 86_400_000);
    expect((await scan()).status).toBe("ok");
    const fourth = await latestScan(created!.id);
    expect(fourth.revalidated).toBe(1);
    expect(fourth.fetchedBytes).toBe(0);
    expect(fourth.closedCount).toBe(1);
    const [closed] = await db.select().from(schema.jobs).where(eq(schema.jobs.externalKey, `id:${JOB_OPERATIONS_MANAGER.id}`));
    expect(closed!.status).toBe("closed");
    expect(closed!.closedAt).toBeInstanceOf(Date);
  }, 180_000);

  it("rewrites no job row on an unchanged board, and only the row that moved when one does", async () => {
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [source] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, company.id));
    const snapshot = async () => (await db.select({ key: schema.jobs.externalKey, updatedAt: schema.jobs.updatedAt, hash: schema.jobs.descriptionHash, fetchedAt: schema.jobs.descriptionFetchedAt }).from(schema.jobs).orderBy(schema.jobs.externalKey));
    const before = await snapshot();
    now = new Date(now.getTime() + 86_400_000);
    expect((await _scanSourceForTests(deps, company, await currentSource(source!.id), await deps.settings(), null)).status).toBe("ok");
    expect(await snapshot()).toEqual(before);

    setJobs([{ ...JOB_OPERATIONS_MANAGER, title: "Senior Operations Manager" }, JOB_ENGINEER, JOB_OPS_NEW_YORK, JOB_OPS_REMOTE_US, JOB_OPS_REMOTE_UK]);
    now = new Date(now.getTime() + 86_400_000);
    await _scanSourceForTests(deps, company, await currentSource(source!.id), await deps.settings(), null);
    const after = await snapshot();
    const moved = after.filter((row, i) => row.updatedAt.getTime() !== before[i]!.updatedAt.getTime()).map(row => row.key);
    expect(moved).toEqual([`id:${JOB_OPERATIONS_MANAGER.id}`]);
    expect(after.map(row => row.hash)).toEqual(before.map(row => row.hash));
  }, 90_000);

  it("keeps a description stored while its commit was running, not the older text it read", async () => {
    // fetch_description takes no lock on the source, so it can commit between the commit reading a
    // row and writing it. The scan must never put back the older text it read.
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [source] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, company.id));
    const [target] = await db.select().from(schema.jobs).where(eq(schema.jobs.externalKey, `id:${JOB_OPERATIONS_MANAGER.id}`));
    await db.update(schema.jobs).set({ descriptionText: null, descriptionHash: null, descriptionFetchedAt: null }).where(eq(schema.jobs.id, target!.id));
    const text = "Own operations for our London site, written while the commit ran.";
    // Fire the concurrent write just before the commit's first write to `jobs`, which is after it
    // has read every row it reconciles.
    let fired = false;
    const race = async () => {
      fired = true;
      await db.update(schema.jobs).set({ descriptionText: text, descriptionHash: sha1(text), descriptionFetchedAt: new Date(now.getTime() + 1000) }).where(eq(schema.jobs.id, target!.id));
    };
    const racingDb = new Proxy(deps.db, { get(base, prop, receiver) {
      if (prop !== "transaction") return Reflect.get(base, prop, receiver);
      return (body: (tx: unknown) => Promise<unknown>) => base.transaction(tx => body(new Proxy(tx, { get(inner, key, innerReceiver) {
        const value = Reflect.get(inner, key, innerReceiver) as unknown;
        if (key === "update") return (table: unknown) => {
          const builder = (value as (t: unknown) => { set: (v: unknown) => { where: (w: unknown) => Promise<unknown> } }).call(inner, table);
          if (table !== schema.jobs || fired) return builder;
          return { set: (values: unknown) => ({ where: async (where: unknown) => { await race(); return builder.set(values).where(where); } }) };
        };
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(inner) : value;
      } })));
    } });
    now = new Date(now.getTime() + 86_400_000);
    const outcome = await _scanSourceForTests({ ...deps, db: racingDb as WorkerDeps["db"] }, company, await currentSource(source!.id), await deps.settings(), null);
    expect(outcome.status).toBe("ok");
    expect(fired).toBe(true);
    const [after] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, target!.id));
    expect(after!.descriptionText).toBe(text);
    expect(after!.descriptionHash).toBe(sha1(text));
  }, 60_000);

  it("reads the stored descriptions of the roles it lists, not the source's closed history", async () => {
    // A description-matching follower on a board that lists roles without text.
    await setGate({ includeKeywords: ["robotics"], matchFields: ["title", "description"] });
    setJobs([JOB_OPERATIONS_MANAGER, JOB_ENGINEER]);
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [source] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, company.id));
    // Years of closed roles, every one with its description kept.
    await db.insert(schema.jobs).values(Array.from({ length: 60 }, (_, n) => ({
      companyId: company.id, sourceId: source!.id, externalKey: `id:${9_000_000 + n}`, title: `Closed role ${n}`, normalizedTitle: `closed role ${n}`,
      url: `https://job-boards.greenhouse.io/acme/jobs/${9_000_000 + n}`, status: "closed" as const, closedAt: new Date("2026-09-02"),
      // Read after the board last edited the role, so nothing asks for it again.
      descriptionText: `Robotics work, long gone. ${"x".repeat(500)}`, descriptionHash: `hash-${n}`, descriptionFetchedAt: new Date("2026-09-01"),
    })));
    // One of them comes back.
    const returning = { ...JOB_ENGINEER, id: 9_000_007, title: "Closed role 7", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/9000007" };
    setJobs([JOB_OPERATIONS_MANAGER, JOB_ENGINEER, returning]);

    let largest = 0;
    const pool = db.$client as unknown as { query: (...args: unknown[]) => Promise<{ rows?: unknown[] }> };
    const original = pool.query.bind(pool);
    pool.query = (async (...args: unknown[]) => {
      const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "";
      const result = await original(...args);
      if (/"description_text"/.test(text) && /"source_id"/.test(text)) largest = Math.max(largest, result.rows?.length ?? 0);
      return result;
    }) as typeof pool.query;
    try {
      now = new Date(now.getTime() + 86_400_000);
      await db.delete(schema.tasks);
      expect((await _scanSourceForTests(deps, company, await currentSource(source!.id), await deps.settings(), null)).status).toBe("ok");
    } finally {
      pool.query = original as typeof pool.query;
    }
    expect(largest).toBeLessThanOrEqual(3);
    // The reopened role's stored text is what its gate reads: admitted with no fetch queued for it.
    const [back] = await db.select().from(schema.jobs).where(eq(schema.jobs.externalKey, "id:9000007"));
    expect(back!.status).toBe("open");
    expect(await db.select().from(schema.userJobs).where(and(eq(schema.userJobs.userId, user.id), eq(schema.userJobs.jobId, back!.id)))).toHaveLength(1);
    const fetches = (await db.select().from(schema.tasks).where(eq(schema.tasks.type, "fetch_description"))).map(t => (t.payload as { jobId: string }).jobId);
    expect(fetches).not.toContain(back!.id);
  }, 90_000);

  it("reuses the text an unchanged listing carried, however old, instead of reading every role again", async () => {
    // A JSON-LD listing large enough to be revalidated by validator carries each role's text. When
    // it comes back unchanged a week later, the text it carried is the text stored.
    const roles = Array.from({ length: 300 }, (_, i) => i + 1);
    const page = `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": roles.map(n => ({
      "@type": "JobPosting", title: `Operations Role ${n}`, url: `https://pager.example/jobs/${n}`, identifier: { value: `role-${n}` },
      description: `Warehouse operations on the night shift, role ${n}. ${"Keep the floor moving. ".repeat(90)}`,
      jobLocation: { address: { addressLocality: "London", addressCountry: "UK" } },
    })) })}</script></head><body></body></html>`;
    expect(page.length).toBeGreaterThan(512 * 1024);
    const etag = "listing-1";
    server.setRoutes({ "pager.example": {
      "/robots.txt": { body: "User-agent: *\nAllow: /\n", contentType: "text/plain" },
      "/postings": (req: import("node:http").IncomingMessage) => req.headers["if-none-match"] === etag
        ? { status: 304, body: "", headers: { etag } } : { body: page, headers: { etag }, contentType: "text/html" },
    } });
    await setGate({ includeKeywords: ["warehouse"], matchFields: ["title", "description"] });
    const [company] = await db.insert(schema.companies).values({ name: "Pager", domain: "pager.example", homepageUrl: "https://pager.example/" }).returning();
    await subscribeToCompany(db, user.id, company!.id);
    const [created] = await db.insert(schema.careerSources).values({ companyId: company!.id, type: "jsonld", url: "https://pager.example/postings", status: "active" }).returning();

    expect((await _scanSourceForTests(deps, company!, created!, await deps.settings(), null)).status).toBe("ok");
    expect((await latestScan(created!.id)).requests).toBe(1);
    expect((await db.select().from(schema.jobs)).every(job => job.descriptionText?.startsWith("Warehouse operations"))).toBe(true);

    now = new Date(now.getTime() + 8 * 86_400_000);
    const outcome = await _scanSourceForTests(deps, company!, await currentSource(created!.id), await deps.settings(), null);
    expect(outcome.status).toBe("ok");
    const reused = await latestScan(created!.id);
    expect(reused.requests).toBe(1);
    expect(reused.revalidated).toBe(1);
    expect((await db.select().from(schema.userJobs)).filter(v => v.inTable)).toHaveLength(300);
  }, 120_000);

  it("scores a new role once, after its description arrives, not also before it", async () => {
    await setGate({});
    const [company] = await db.insert(schema.companies).values({ name: "Acme Robotics", domain: "acme.example", homepageUrl: "https://www.acme.example/" }).returning();
    await subscribeToCompany(db, user.id, company!.id);
    await db.insert(schema.userSettings).values({ userId: user.id, key: "aiBudgetUsd", value: 25 });
    const [source] = await db.insert(schema.careerSources).values({
      companyId: company!.id, type: "greenhouse", url: "https://job-boards.greenhouse.io/acme",
      apiUrl: "https://boards-api.greenhouse.io/v1/boards/acme/jobs", atsSlug: "acme", status: "active",
    }).returning();
    const aiDeps = { ...deps, ai: { ...deps.ai, enabled: true } } as unknown as WorkerDeps;
    await _scanSourceForTests(aiDeps, company!, source!, await deps.settings(), null);
    const scores = async () => (await db.select().from(schema.tasks).where(eq(schema.tasks.type, "score_job"))).map(t => (t.payload as { jobId: string }).jobId);
    // The listing carries no text, so every admitted role waits for its description.
    expect(await scores()).toEqual([]);
    expect(await db.select().from(schema.tasks).where(eq(schema.tasks.type, "fetch_description"))).toHaveLength(4);
    await queue.drain();
    const queued = await scores();
    expect(queued).toHaveLength(4);
    expect(new Set(queued).size).toBe(4);
  }, 90_000);

  it("stops at its request budget and records a partial scan that closes nothing", async () => {
    // A description-matching gate on a listing that carries no descriptions is one request per
    // role. Unbounded, that scan runs until its three-minute deadline kills it; bounded, it stops
    // and says so, and a scan that did not read the listing out closes nothing.
    const roles = Array.from({ length: 200 }, (_, i) => i + 1);
    const page = (shown: number[]) => `<!doctype html><html><body><ul class="roles">${shown
      .map(n => `<li><a href="/jobs/${n}">Operations Role ${n}</a><span>London, UK</span></li>`).join("")}</ul></body></html>`;
    const detail = (n: number) => `<!doctype html><html><body><main>${"Warehouse operations work on the night shift. ".repeat(20)} Role ${n}.</main></body></html>`;
    const routesFor = (shown: number[]) => ({ "pager.example": {
      "/robots.txt": { body: "User-agent: *\nAllow: /\n", contentType: "text/plain" },
      "/jobs": { body: page(shown) },
      ...Object.fromEntries(roles.map(n => [`/jobs/${n}`, { body: detail(n) }])),
    } });
    server.setRoutes(routesFor(roles));
    await setGate({});
    const [company] = await db.insert(schema.companies).values({ name: "Pager", domain: "pager.example", homepageUrl: "https://pager.example/" }).returning();
    await subscribeToCompany(db, user.id, company!.id);
    const [created] = await db.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://pager.example/jobs", status: "active" }).returning();

    // A title gate needs no detail text, so the complete first scan costs one request.
    expect((await _scanSourceForTests(deps, company!, created!, await deps.settings(), null)).status).toBe("ok");
    expect(await db.select().from(schema.jobs)).toHaveLength(200);

    // Now the gate matches on the description, and one role comes down the same day.
    await setGate({ includeKeywords: ["warehouse"], matchFields: ["title", "description"] });
    deps.invalidateSettings();
    server.setRoutes(routesFor(roles.filter(n => n !== 200)));
    now = new Date(now.getTime() + 86_400_000);
    const outcome = await _scanSourceForTests(deps, company!, await currentSource(created!.id), await deps.settings(), null);
    expect(outcome.status).toBe("partial");
    expect(outcome.closedCount).toBe(0);
    const stopped = await latestScan(created!.id);
    expect(stopped.status).toBe("partial");
    expect(stopped.requests).toBe(150);
    expect(stopped.error).toContain("budget of 150 requests");
    // The role that came down is not closed, not missing, and not counted against: an incomplete
    // scan is not evidence of absence.
    const rows = await db.select().from(schema.jobs);
    expect(rows.every(job => job.status === "open" && job.missingScans === 0)).toBe(true);
  }, 240_000);
});

/** How many statements matching `pattern` the body sends, pooled or inside a transaction. */
async function countingQueries(pattern: RegExp, body: () => Promise<unknown>): Promise<number> {
  type Client = { query: (...args: unknown[]) => unknown };
  type Pool = { on: (event: "acquire", listener: (client: Client) => void) => void; removeListener: (event: "acquire", listener: (client: Client) => void) => void };
  const pool = db.$client as unknown as Pool;
  let n = 0;
  // Each client the pool hands out, for one statement or a whole transaction, is counted while the
  // body runs; the pool wraps every client's own `query`, so the count wraps that in turn.
  const counted = new Map<Client, Client["query"]>();
  const onAcquire = (client: Client) => {
    if (counted.has(client)) return;
    const query = client.query;
    counted.set(client, query);
    client.query = function (this: unknown, ...args: unknown[]) {
      const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text ?? "";
      if (pattern.test(text)) n++;
      return query.apply(this, args);
    };
  };
  pool.on("acquire", onAcquire);
  try {
    await body();
  } finally {
    pool.removeListener("acquire", onAcquire);
    for (const [client, query] of counted) client.query = query;
  }
  return n;
}

describe("a description arriving", () => {
  async function follow(companyId: string, n: number, gate: Record<string, unknown>) {
    const follower = await ensureTestUser(db, `follower-${n}@example.com`, "member");
    await db.insert(schema.userSettings).values({ userId: follower.id, key: "gate", value: { excludeKeywords: [], locationTerms: [], includeRemote: true, ...gate } });
    await subscribeToCompany(db, follower.id, companyId);
    return follower;
  }
  const titleGate = { includeKeywords: ["engineer"], matchFields: ["title"] };
  const descriptionGate = { includeKeywords: ["platform"], matchFields: ["title", "description"] };

  it("re-runs every follower's gate in the same statements for thirty followers as for three", async () => {
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const byKey = async (id: number) => (await db.select().from(schema.jobs).where(eq(schema.jobs.externalKey, `id:${id}`)))[0]!;
    const clear = (jobId: string) => db.update(schema.jobs).set({ descriptionText: null, descriptionHash: null, descriptionFetchedAt: null }).where(eq(schema.jobs.id, jobId));
    const perFollower = /user_jobs|user_settings|"tasks"|insert into "tasks"|decisions/;

    const followers = [await follow(company.id, 0, titleGate), await follow(company.id, 1, descriptionGate)];
    const engineer = await byKey(JOB_ENGINEER.id);
    await clear(engineer.id);
    const few = await countingQueries(perFollower, () => handleFetchDescription({ payload: { jobId: engineer.id } } as never, deps));

    // The same arrival again, now with 29 followers, 27 of them new to the role.
    for (let n = 2; n < 29; n++) followers.push(await follow(company.id, n, n % 3 === 0 ? descriptionGate : titleGate));
    await clear(engineer.id);
    const many = await countingQueries(perFollower, () => handleFetchDescription({ payload: { jobId: engineer.id } } as never, deps));
    expect(few).toBeGreaterThan(0);
    expect(many).toBe(few);

    // And the verdicts are every follower's own: all 29 match the engineer role, by title or by
    // the "Build the platform." text that just arrived; the first account's gate does not.
    const views = await db.select().from(schema.userJobs).where(eq(schema.userJobs.jobId, engineer.id));
    expect(new Set(views.filter(v => v.inTable).map(v => v.userId))).toEqual(new Set(followers.map(f => f.id)));
    expect(views.some(v => v.userId === user.id)).toBe(false);
    const scored = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, "score_job"), sql`payload->>'jobId' = ${engineer.id}`));
    expect(scored).toHaveLength(29);
  }, 120_000);

  it("queues a fresh score for a role shortlisted outside the table when its text changes", async () => {
    await setGate({});
    await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [manager] = await db.select().from(schema.jobs).where(eq(schema.jobs.externalKey, `id:${JOB_OPERATIONS_MANAGER.id}`));
    await db.update(schema.userJobs).set({ inTable: false, fitScore: 55, scoredAt: now })
      .where(and(eq(schema.userJobs.userId, user.id), eq(schema.userJobs.jobId, manager!.id)));
    await db.insert(schema.decisions).values({ userId: user.id, jobId: manager!.id, decision: "apply", jobTitle: manager!.title, companyName: "Acme" });
    await db.update(schema.jobs).set({ descriptionHash: "an older text" }).where(eq(schema.jobs.id, manager!.id));
    await db.delete(schema.tasks);

    await handleFetchDescription({ payload: { jobId: manager!.id } } as never, deps);
    const [view] = await db.select().from(schema.userJobs).where(and(eq(schema.userJobs.userId, user.id), eq(schema.userJobs.jobId, manager!.id)));
    expect(view).toMatchObject({ fitScore: null, scoredAt: null, scoreState: "queued" });
    const queued = await db.select().from(schema.tasks).where(eq(schema.tasks.type, "score_job"));
    expect(queued.map(t => t.payload)).toEqual([{ userId: user.id, jobId: manager!.id }]);
  }, 60_000);

  it("keeps a cleaned description only when the page says what it says", async () => {
    const [company] = await db.insert(schema.companies).values({ name: "Acme", domain: "acme.example", homepageUrl: "https://www.acme.example/" }).returning();
    const [source] = await db.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://www.acme.example/listing", status: "active" }).returning();
    const page = "<html><body><nav>Home Careers</nav><main><h1>Operations Lead</h1><p>Run our London site.</p><p>Hybrid, three days a week.</p></main><footer>Cookies</footer></body></html>";
    server.setRoutes({ "www.acme.example": { "/robots.txt": { body: "User-agent: *\nAllow: /" }, "/jobs/lead": { body: page }, "/jobs/other": { body: page } } });
    const insertJob = async (path: string) => (await db.insert(schema.jobs).values({ companyId: company!.id, sourceId: source!.id, externalKey: `url:${path}`, title: "Operations Lead", normalizedTitle: "operations lead", url: `https://www.acme.example${path}` }).returning())[0]!;
    const faithful = await insertJob("/jobs/lead");
    const invented = await insertJob("/jobs/other");
    const cleanDescription = vi.fn()
      .mockResolvedValueOnce({ descriptionText: "Run our London site.\nHybrid, three days a week.", remote: false })
      .mockResolvedValueOnce({ descriptionText: "Run our London site. Robotics experts wanted, salary 200k.", salaryText: "200k" });
    const modelDeps = { ...deps, ai: { ...deps.ai, enabled: true, cleanDescription } } as unknown as WorkerDeps;

    await handleFetchDescription({ payload: { jobId: faithful.id } } as never, modelDeps);
    await handleFetchDescription({ payload: { jobId: invented.id } } as never, modelDeps);
    expect(cleanDescription).toHaveBeenCalledTimes(2);
    const [kept] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, faithful.id));
    expect(kept).toMatchObject({ descriptionSource: "model", descriptionText: "Run our London site.\nHybrid, three days a week." });
    // Refused: what the page's own reading gave is kept (here nothing), and none of the claims.
    const [refused] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, invented.id));
    expect(refused!.descriptionSource).not.toBe("model");
    expect(refused!.descriptionText ?? "").not.toContain("Robotics");
    expect(refused!.salaryText).toBeNull();
    expect(refused!.descriptionFetchedAt).not.toBeNull();
  }, 60_000);

  it("anchors a cleaned description sentence by sentence, whatever the spacing and punctuation", () => {
    const raw = "Home | Careers\nOperations Lead — Run our London site!  Hybrid, three days a week. Apply now";
    expect(anchoredInPage("Run our London site. Hybrid, three days a week.", raw)).toBe(true);
    expect(anchoredInPage("Run our London site.\n\nHybrid three days a week", raw)).toBe(true);
    expect(anchoredInPage("Run our London site. Lead the robotics lab.", raw)).toBe(false);
    // A sentence must be whole words of the page, not a fragment inside a longer word.
    expect(anchoredInPage("Ondon site", raw)).toBe(false);
    expect(anchoredInPage("", raw)).toBe(false);
  });
});

describe("a host that has asked us to wait", () => {
  const pace = (minutes: number) => db.execute(sql`insert into host_pacing (host, next_at) values ('boards-api.greenhouse.io', now() + ${minutes} * interval '1 minute')
    on conflict (host) do update set next_at = excluded.next_at`);

  it("puts the scan back for when the host allows it, and records nothing against the source", async () => {
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [source] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, company.id));
    const scansBefore = (await db.select().from(schema.scans)).length;
    const jobsBefore = await db.select({ id: schema.jobs.id, missingScans: schema.jobs.missingScans, status: schema.jobs.status }).from(schema.jobs).orderBy(schema.jobs.id);
    await db.delete(schema.tasks);
    await pace(60);
    try {
      now = new Date(now.getTime() + 86_400_000);
      await enqueueTask(db, "scan_company", { companyId: company.id, trigger: "manual" }, { dedupeKey: dedupeKeyFor("scan_company", { companyId: company.id }), priority: 5 });
      await queue.drain();

      // Nothing was sent, so nothing was observed: no scan, no miss, no failure, no backoff.
      expect(await db.select().from(schema.scans)).toHaveLength(scansBefore);
      expect(await db.select({ id: schema.jobs.id, missingScans: schema.jobs.missingScans, status: schema.jobs.status }).from(schema.jobs).orderBy(schema.jobs.id)).toEqual(jobsBefore);
      const [untouched] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source!.id));
      expect(untouched).toMatchObject({ consecutiveFailures: 0, nextScanAt: null, status: "active" });
      const retries = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, "scan_company"), eq(schema.tasks.status, "queued")));
      expect(retries).toHaveLength(1);
      expect(retries[0]!.payload).toMatchObject({ companyId: company.id, trigger: "manual", sourceIds: [source!.id], hostBusyRetries: 1 });
      expect(retries[0]!.runAfter!.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);

      // When the pace allows, the task put back reads the board as usual.
      await db.execute(sql`delete from host_pacing`);
      await db.update(schema.tasks).set({ runAfter: new Date() }).where(eq(schema.tasks.id, retries[0]!.id));
      await queue.drain();
      const [latest] = await db.select().from(schema.scans).where(eq(schema.scans.sourceId, source!.id)).orderBy(desc(schema.scans.startedAt)).limit(1);
      expect(latest!.status).toBe("ok");
    } finally {
      await db.execute(sql`delete from host_pacing`);
    }
  }, 90_000);

  it("records a scan that could not be put back as failed without counting it against the source", async () => {
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [source] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, company.id));
    await pace(60);
    try {
      now = new Date(now.getTime() + 86_400_000);
      const outcome = await _scanSourceForTests(deps, company, source!, await deps.settings(), null);
      expect(outcome.status).toBe("failed");
      const [scan] = await db.select().from(schema.scans).where(eq(schema.scans.sourceId, source!.id)).orderBy(desc(schema.scans.startedAt)).limit(1);
      expect(scan!.error).toContain("paced until");
      const [after] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source!.id));
      expect(after).toMatchObject({ consecutiveFailures: 0, nextScanAt: null, status: "active" });
      expect((await db.select().from(schema.jobs)).every(job => job.status === "open" && job.missingScans === 0)).toBe(true);
    } finally {
      await db.execute(sql`delete from host_pacing`);
    }
  }, 60_000);
});

it("reads a Workday board past 150 pages whole, so it is a successful scan that can close roles", async () => {
  // Twenty roles a page: a 3,500-role board is 175 requests, which the old per-scan budget of 150
  // always cut short into a partial scan that could close nothing.
  const total = 3500;
  const posting = (n: number) => ({ title: `Operations Analyst ${n}`, externalPath: `/job/London/Operations-Analyst_R${n}`, locationsText: "London", postedOn: "Posted Today", bulletFields: [`R${n}`] });
  let listed = total;
  server.setRoutes({ "acme.wd1.myworkdayjobs.com": {
    "/wday/cxs/acme/External/jobs": (_req, body) => {
      const { offset = 0, limit = 20 } = JSON.parse(body || "{}") as { offset?: number; limit?: number };
      const jobPostings = Array.from({ length: Math.max(0, Math.min(limit, listed - offset)) }, (_, i) => posting(offset + i));
      return { body: { total: listed, jobPostings } };
    },
  } });
  await setGate({});
  const [company] = await db.insert(schema.companies).values({ name: "Acme", domain: "acme.example", homepageUrl: "https://www.acme.example/" }).returning();
  await subscribeToCompany(db, user.id, company!.id);
  const [source] = await db.insert(schema.careerSources).values({
    companyId: company!.id, type: "workday", url: "https://acme.wd1.myworkdayjobs.com/External",
    apiUrl: "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External/jobs", atsSlug: "acme", atsSite: "acme.wd1.myworkdayjobs.com|External", status: "active",
  }).returning();
  const scanOn = async (day: string) => {
    now = new Date(`${day}T06:00:00Z`);
    const [current] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source!.id));
    return _scanSourceForTests(deps, company!, current!, await deps.settings(), null);
  };
  const first = await scanOn("2026-09-06");
  expect(first).toMatchObject({ status: "ok", postingsFound: total });
  const [scan] = await db.select().from(schema.scans).where(eq(schema.scans.sourceId, source!.id)).orderBy(desc(schema.scans.startedAt)).limit(1);
  expect(scan!.requests).toBe(total / 20);

  // The last role comes down and stays down: two complete scans a day apart close it.
  listed = total - 1;
  expect((await scanOn("2026-09-07")).status).toBe("ok");
  expect((await scanOn("2026-09-08")).closedCount).toBe(1);
}, 180_000);

it("closes the roles of a retired source and of a company nobody follows, and says why", async () => {
  await setGate({});
  const company = await addCompany("https://www.acme.example/", "acme.example");
  await queue.drain();
  const [live] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, company.id));
  // A guessed board discovery superseded, with two roles it once listed and one a follower pasted.
  const [superseded] = await db.insert(schema.careerSources).values({ companyId: company.id, type: "lever", url: "https://jobs.lever.co/acme-old", status: "disabled" }).returning();
  const seenAt = new Date("2026-08-20T06:00:00Z");
  const roleOn = (sourceId: string, key: string, extra: Partial<typeof schema.jobs.$inferInsert> = {}) => ({
    companyId: company.id, sourceId, externalKey: key, title: `Role ${key}`, normalizedTitle: `role ${key}`, url: `https://jobs.lever.co/acme-old/${key}`, lastSeenAt: seenAt, ...extra,
  });
  const old = await db.insert(schema.jobs).values([roleOn(superseded!.id, "a"), roleOn(superseded!.id, "b"), roleOn(superseded!.id, "c", { origin: "user", addedBy: user.id })]).returning();
  // A company its only follower left.
  const [orphan] = await db.insert(schema.companies).values({ name: "Gone", domain: "gone.example", homepageUrl: "https://gone.example/", status: "archived" }).returning();
  const [orphanSource] = await db.insert(schema.careerSources).values({ companyId: orphan!.id, type: "html", url: "https://gone.example/jobs", status: "active" }).returning();
  const [orphanRole] = await db.insert(schema.jobs).values({ companyId: orphan!.id, sourceId: orphanSource!.id, externalKey: "z", title: "Role z", normalizedTitle: "role z", url: "https://gone.example/jobs/z", lastSeenAt: seenAt }).returning();

  await handleRunDaily({ payload: { trigger: "manual" } } as never, deps);
  const byId = new Map((await db.select().from(schema.jobs)).map(job => [job.id, job]));
  for (const job of [old[0]!, old[1]!, orphanRole!]) {
    expect(byId.get(job.id)).toMatchObject({ status: "closed", closedAt: seenAt });
    const [event] = await db.select().from(schema.jobEvents).where(and(eq(schema.jobEvents.jobId, job.id), eq(schema.jobEvents.type, "closed")));
    expect(event!.payload).toMatchObject({ reason: "source_retired" });
  }
  // A pasted role was never that source's to lose, and the live source's roles are untouched.
  expect(byId.get(old[2]!.id)!.status).toBe("open");
  const liveRoles = [...byId.values()].filter(job => job.sourceId === live!.id);
  expect(liveRoles).toHaveLength(5);
  expect(liveRoles.every(job => job.status === "open")).toBe(true);

  // Retiring one source by hand, as disabling it does, closes that source's roles and no other's.
  await db.update(schema.careerSources).set({ status: "disabled" }).where(eq(schema.careerSources.id, live!.id));
  expect(await retireSourceRoles(db, { sourceId: superseded!.id })).toBe(0);
  expect(await retireSourceRoles(db, { sourceId: live!.id })).toBe(5);
}, 60_000);

describe("mining the scans for suggestions", () => {
  it("queues a week's mining only for accounts whose companies the run scanned, in one pass", async () => {
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const bystander = await ensureTestUser(db, "follows-nothing@example.com", "member");
    await db.delete(schema.tasks);

    await handleRunDaily({ payload: { trigger: "manual" } } as never, deps);
    // Run the scan the fan-out queued, then finalise the run by hand, so the mining tasks stay queued.
    const [scanTask] = await db.select().from(schema.tasks).where(eq(schema.tasks.type, "scan_company"));
    await handleScanCompany(scanTask!, deps);
    await db.update(schema.tasks).set({ status: "done" }).where(eq(schema.tasks.id, scanTask!.id));
    expect(await finaliseScanRuns(deps)).toBe(1);
    const mining = await db.select().from(schema.tasks).where(eq(schema.tasks.type, "suggest_from_scans"));
    expect(mining.map(t => t.payload)).toEqual([{ userId: user.id, scheduled: true }]);
    expect(mining.some(t => (t.payload as { userId: string }).userId === bystander.id)).toBe(false);

    // Mined now, so a scheduled run tomorrow skips it, while asking on Learning still mines.
    expect(await handleSuggestFromScans(mining[0]!, deps)).not.toMatchObject({ skipped: expect.anything() });
    now = new Date(now.getTime() + 86_400_000);
    expect(await handleSuggestFromScans({ ...mining[0]!, payload: { userId: user.id, scheduled: true } } as never, deps)).toEqual({ skipped: "suggested within the week" });
    expect(await handleSuggestFromScans({ ...mining[0]!, payload: { userId: user.id } } as never, deps)).not.toMatchObject({ skipped: expect.anything() });
    // And the next run's finalise does not queue it at all.
    await db.delete(schema.tasks);
    await handleRunDaily({ payload: { trigger: "manual", runDate: "2026-09-06" } } as never, deps);
    const [again] = await db.select().from(schema.tasks).where(eq(schema.tasks.type, "scan_company"));
    await handleScanCompany(again!, deps);
    await db.update(schema.tasks).set({ status: "done" }).where(eq(schema.tasks.id, again!.id));
    await finaliseScanRuns(deps);
    expect(await db.select().from(schema.tasks).where(eq(schema.tasks.type, "suggest_from_scans"))).toHaveLength(0);
    void company;
  }, 90_000);

  it("reads a snapshot two followers share once, not once each", async () => {
    await setGate({});
    const company = await addCompany("https://www.acme.example/", "acme.example");
    const second = await ensureTestUser(db, "second-miner@example.com", "member");
    await db.insert(schema.userSettings).values({ userId: second.id, key: "gate", value: { includeKeywords: ["engineer"], excludeKeywords: [], matchFields: ["title"], locationTerms: [], includeRemote: true } });
    await subscribeToCompany(db, second.id, company.id);
    await queue.drain();
    const snapshotReads = await countingQueries(/select "raw_snapshot" from "scans"/, async () => {
      for (const account of [user, second]) await handleSuggestFromScans({ payload: { userId: account.id } } as never, deps);
    });
    expect(snapshotReads).toBe(1);
  }, 60_000);
});
