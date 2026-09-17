/**
 * End-to-end test over a real Postgres database and a fake company website.
 * Covers the whole path the spec describes: add a homepage URL, discover the careers source,
 * scan it, apply the keyword and location gate, then detect a removed role two scans later.
 *
 * Requires a database: set TEST_DATABASE_URL (defaults to the local christopher_test database).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {createDb, schema, enqueueTask, reevaluateGate, subscribeToCompany, type Db, type User} from "@christopher/db";
import { ensureTestUser } from "./test-users";
import { runMigrations } from "@christopher/db/migrate";
import { ats, dedupeKeyFor, displayStatus, liveFor, priorityFor, sha1 } from "@christopher/core";
import { and, desc, eq, sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { handlers } from "./handlers";
import { _scanSourceForTests } from "./handlers/scan";
import { handleScoreJob, handleTagReason } from "./handlers/learning";
import { handleRunDaily, finaliseScanRuns } from "./handlers/daily";
import { TaskQueue } from "./queue";
import { startTestServer, type RouteTable, type TestServer } from "./test-server";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test";
const HOSTS = ["www.acme.example", "acme.example", "boards-api.greenhouse.io", "job-boards.greenhouse.io", "www.orbital.example", "orbital.example"];

/** An Anthropic-style site: homepage -> careers landing -> listing backed by a Greenhouse board. */
function acmeRoutes(): RouteTable[string] {
  return {
    "/favicon.png": { body: "test icon", contentType: "image/png" },
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

function greenhouseRoutes(jobs: object): RouteTable[string] {
  return {
    "/v1/boards/acme/jobs": { body: jobs },
    "/v1/boards/acme": { body: { name: "Acme Robotics", content: "About Acme" } },
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

function setJobs(jobs: unknown[]) {
  server.setRoutes({
    "www.acme.example": acmeRoutes(),
    "acme.example": acmeRoutes(),
    "boards-api.greenhouse.io": greenhouseRoutes({ jobs, meta: { total: jobs.length } }),
    "job-boards.greenhouse.io": {},
  });
}

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();

  server = await startTestServer({}, HOSTS);
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.CHRISTOPHER_HOST_MAP = JSON.stringify(server.hostMap);
  process.env.CHRISTOPHER_DISABLE_BROWSER = "1";
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

    setJobs([JOB_ENGINEER]);
    for (let i = 0; i < 2; i++) {
      now = new Date(now.getTime() + 86_400_000);
      await enqueueTask(db, "scan_company", { companyId: company.id, trigger: "manual" }, { dedupeKey: dedupeKeyFor("scan_company", { companyId: company.id }), priority: 5 });
      await queue.drain();
    }
    expect((await jobsInTable()).find((r) => r.title === "Operations Manager")!.status).toBe("closed");

    setJobs([JOB_OPERATIONS_MANAGER, JOB_ENGINEER]);
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
    await db.insert(schema.decisions).values({ userId: user.id, jobId: saved!.id, decision: "skip", reason: "Too junior", jobTitle: saved!.title, companyName: company.name });
    setJobs([{ ...JOB_OPERATIONS_MANAGER, title: "Engineering Manager", location: { name: "New York, USA" }, offices: [], content: "A changed engineering description", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4001001?updated=1" }, JOB_ENGINEER, JOB_OPS_NEW_YORK, JOB_OPS_REMOTE_US, JOB_OPS_REMOTE_UK]);
    const [source] = await db.select().from(schema.careerSources);
    await _scanSourceForTests(deps, company, source!, await deps.settings(), null);
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.externalKey, "id:4001001"));
    expect(job!.title).toBe("Engineering Manager");
    expect(job!.descriptionText).toContain("changed engineering");
    expect(job!.descriptionSource).toBe("direct");
    expect(job!.descriptionTruncated).toBe(false);
    expect(job!.url).toContain("updated=1");
    const [view] = await db.select().from(schema.userJobs).where(eq(schema.userJobs.jobId, job!.id));
    expect(view!.inTable).toBe(false);
    expect(view!.locationOk).toBe(false);
    expect(view!.nearMiss).toBe(false);
    setJobs([{ ...JOB_OPERATIONS_MANAGER, content: 'Operations planning and reporting. '.repeat(1200) }]);
    await _scanSourceForTests(deps, company, source!, await deps.settings(), null);
    const [truncated] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, saved!.id));
    expect(truncated!.descriptionText).toHaveLength(30000);
    expect(truncated!.descriptionTruncated).toBe(true);
    expect(truncated!.descriptionHash).toBe(sha1(truncated!.descriptionText!));
  }, 60_000);

  it("archives retained non-matches but preserves active decisions", async () => {
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
    expect(kept.filter(job => job.archivedAt)).toHaveLength(3);
    expect(kept.every(j => !j.inTable && !j.nearMiss)).toBe(true);
    expect((await db.select().from(schema.decisions))[0]!.reason).toBe("Too junior");
  });

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

  it("does not reset missing counters on a partial scan", async () => {
    const company = await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [source] = await db.select().from(schema.careerSources);
    await db.update(schema.jobs).set({ missingScans: 1 });
    await db.insert(schema.scans).values({ sourceId: source!.id, status: "ok", postingsFound: 20, startedAt: new Date("2099-01-01") });
    setJobs([JOB_OPERATIONS_MANAGER, JOB_ENGINEER]);
    const outcome = await _scanSourceForTests(deps, company, source!, await deps.settings(), null);
    expect(outcome.status).toBe("partial");
    const jobs = await db.select().from(schema.jobs);
    expect(jobs.every(job => job.missingScans === 1 && job.status === "open")).toBe(true);
  }, 60_000);

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
    await handleScoreJob(task, scoringDeps);
    await handleScoreJob(task, scoringDeps);
    expect(scoreJob).toHaveBeenCalledTimes(1);
    await db.insert(schema.cvLibraries).values({ userId: user.id, version: 100, content: { name: 'Test', contact: '', profile: 'New evidence', entries: [] } });
    await handleScoreJob(task, scoringDeps);
    expect(scoreJob).toHaveBeenCalledTimes(2);
  });
  it("skips an exhausted account's scoring cleanly, and scores again once its budget is raised", async () => {
    await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const [view] = await db.select().from(schema.userJobs).where(eq(schema.userJobs.inTable, true));
    const scoreJob = vi.fn().mockResolvedValue({ score: 80, verdict: "strong", rationale: "Fixture" });
    const scoringDeps = { ...deps, ai: { ...deps.ai, enabled: true, scoreJob } } as unknown as WorkerDeps;
    const task = { payload: { userId: user.id, jobId: view!.jobId } } as never;
    // This account's $1 is spent; the shared ceiling is untouched, so only this account stops.
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
    await _scanSourceForTests(aiDeps, company, source!, await deps.settings(), null);
    // The scan still observes and stores everything; only this account's scoring is held back,
    // and no task was queued that could only fail at the hold.
    expect(await scoreTasks()).toHaveLength(0);
    expect((await db.select().from(schema.userJobs).where(eq(schema.userJobs.inTable, true))).length).toBeGreaterThan(0);
    expect((await db.select().from(schema.tasks)).filter((row) => row.status === "failed")).toHaveLength(0);

    await budget(25);
    await _scanSourceForTests(aiDeps, company, source!, await deps.settings(), null);
    expect((await scoreTasks()).length).toBeGreaterThan(0);
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
  setJobs(filler.slice(0, 3));
  const scanAt = async (day: string) => {
    now = new Date(`${day}T06:00:00Z`);
    await enqueueTask(db, "scan_company", { companyId: company.id, trigger: "manual" }, { dedupeKey: dedupeKeyFor("scan_company", { companyId: company.id }), priority: 5 });
    await queue.drain();
  };
  await scanAt("2026-09-06");
  await scanAt("2026-09-07");
  let discovers = await db.select().from(schema.tasks).where(sql`type = 'discover' and payload->>'reason' = 'shrunk'`);
  expect(discovers).toHaveLength(0);
  await scanAt("2026-09-08");
  discovers = await db.select().from(schema.tasks).where(sql`type = 'discover' and payload->>'reason' = 'shrunk'`);
  expect(discovers.length).toBeGreaterThanOrEqual(1);
  const scans = await db.select().from(schema.scans).orderBy(schema.scans.startedAt);
  expect(scans.slice(-3).every(scan => scan.status === "partial" && /shrank/.test(scan.error ?? ""))).toBe(true);
  const manager = (await jobsInTable()).find(r => r.title === "Operations Manager")!;
  expect(manager.status).toBe("open");
  expect(manager.missingScans).toBe(0);
}, 120_000);

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
  await expect(handleProfileCompany({ payload: { companyId: company.id } } as unknown as import("@christopher/db").Task, lost)).rejects.toThrow("lease lost");
  expect((await db.select().from(schema.companyProfiles))[0]!.sector).toBe("Previous sector");
  await handleProfileCompany({ payload: { companyId: company.id } } as unknown as import("@christopher/db").Task, { ...deps, ai: fakeAi });
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
    const { setSubscriptionStatus } = await import("@christopher/db");
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
});
