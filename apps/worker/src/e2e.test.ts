/**
 * End-to-end test over a real Postgres database and a fake company website.
 * Covers the whole path the spec describes: add a homepage URL, discover the careers source,
 * scan it, apply the keyword and location gate, then detect a removed role two scans later.
 *
 * Requires a database: set TEST_DATABASE_URL (defaults to the local christopher_test database).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {createDb, schema, enqueueTask, type Db} from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { dedupeKeyFor, displayStatus, liveFor, priorityFor } from "@christopher/core";
import { desc, eq, sql } from "drizzle-orm";
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
  await db.execute(sql`truncate companies, career_sources, discovery_runs, scan_runs, scans, jobs, job_events, decisions, tasks, settings, ai_calls, company_profiles, company_suggestions, filter_suggestions, preference_profiles restart identity cascade`);
  now = new Date("2026-09-05T06:00:00Z");
  setJobs([JOB_OPERATIONS_MANAGER, JOB_ENGINEER, JOB_OPS_NEW_YORK, JOB_OPS_REMOTE_US, JOB_OPS_REMOTE_UK]);
});

async function setGate(gate: Partial<{ includeKeywords: string[]; excludeKeywords: string[]; locationTerms: string[]; includeRemote: boolean; matchFields: string[] }>) {
  const value = {
    includeKeywords: ["operations"],
    excludeKeywords: [],
    matchFields: ["title"],
    locationTerms: [],
    includeRemote: true,
    ...gate,
  };
  await db.insert(schema.settings).values({ key: "gate", value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
}

async function addCompany(homepageUrl: string, domain: string) {
  const [company] = await db.insert(schema.companies).values({ name: domain, homepageUrl, domain }).returning();
  await enqueueTask(db, "discover", { companyId: company!.id, reason: "added" }, {
    dedupeKey: dedupeKeyFor("discover", { companyId: company!.id }),
    priority: priorityFor("discover"),
  });
  return company!;
}

async function jobsInTable() {
  return db
    .select({
      title: schema.jobs.title,
      location: schema.jobs.location,
      status: schema.jobs.status,
      inTable: schema.jobs.inTable,
      nearMiss: schema.jobs.nearMiss,
      keywordTerms: schema.jobs.keywordTerms,
      postedAt: schema.jobs.postedAt,
      firstSeenAt: schema.jobs.firstSeenAt,
      closedAt: schema.jobs.closedAt,
      seeded: schema.jobs.seeded,
      missingScans: schema.jobs.missingScans,
      url: schema.jobs.url,
    })
    .from(schema.jobs)
    .orderBy(schema.jobs.title);
}

describe("end to end", () => {
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

  it("puts only keyword-matching roles in the table, and records the rest", async () => {
    await setGate({});
    await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();

    const rows = await jobsInTable();
    expect(rows).toHaveLength(5);
    const inTable = rows.filter((r) => r.inTable).map((r) => r.title);
    expect(inTable).toEqual(["Head of Business Operations", "Operations Analyst", "Operations Manager", "Senior Operations Associate"]);
    expect(rows.find((r) => r.title.startsWith("Software"))!.inTable).toBe(false);
    expect(rows.find((r) => r.title === "Operations Manager")!.keywordTerms).toEqual(["operations"]);
    // Every role from the first scan is flagged as seeded so a day-one table is not read as news.
    expect(rows.every((r) => r.seeded)).toBe(true);
    // The engineering role missed the keywords but is otherwise plausible, so it is kept as a
    // near miss the learning loop can surface. Nothing is deleted.
    expect(rows.find((r) => r.title.startsWith("Software"))!.nearMiss).toBe(true);
  }, 60_000);

  it("filters by location, expanding UK and keeping UK-remote roles", async () => {
    await setGate({ locationTerms: ["UK"] });
    await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();

    const rows = await jobsInTable();
    const inTable = rows.filter((r) => r.inTable).map((r) => r.title);
    expect(inTable).toEqual(["Operations Analyst", "Operations Manager"]);
    // New York is out; "Remote - USA" is out because it names another region.
    expect(rows.find((r) => r.title === "Head of Business Operations")!.inTable).toBe(false);
    expect(rows.find((r) => r.title === "Senior Operations Associate")!.inTable).toBe(false);
    expect(rows.find((r) => r.title === "Operations Analyst")!.location).toBe("Remote - UK");
    // A role outside the location filter is not a near miss either: the filter is a hard boundary.
    expect(rows.find((r) => r.title === "Head of Business Operations")!.nearMiss).toBe(false);
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
    setJobs([{ ...JOB_OPERATIONS_MANAGER, title: "Engineering Manager", location: { name: "New York, USA" }, offices: [], content: "A changed engineering description", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4001001?updated=1" }, JOB_ENGINEER, JOB_OPS_NEW_YORK, JOB_OPS_REMOTE_US, JOB_OPS_REMOTE_UK]);
    const [source] = await db.select().from(schema.careerSources);
    await _scanSourceForTests(deps, company, source!, await deps.settings(), null);
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.externalKey, "id:4001001"));
    expect(job!.title).toBe("Engineering Manager");
    expect(job!.descriptionText).toContain("changed engineering");
    expect(job!.url).toContain("updated=1");
    expect(job!.inTable).toBe(false);
    expect(job!.locationOk).toBe(false);
    expect(job!.nearMiss).toBe(false);
  }, 60_000);

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
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.externalKey, "id:4001001"));
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

  it("reserves the near-miss daily allowance atomically across concurrent scores", async () => {
    await addCompany("https://www.acme.example/", "acme.example");
    await queue.drain();
    const near = await db.select().from(schema.jobs).where(eq(schema.jobs.nearMiss, true));
    expect(near.length).toBeGreaterThan(0);
    await db.insert(schema.settings).values({ key: "nearMissDailyCap", value: 1 });
    const scoreJob = vi.fn().mockResolvedValue({ score: 80, verdict: "strong", rationale: "Fixture" });
    const aiDeps = { ...deps, ai: { ...deps.ai, enabled: true, scoreJob } } as unknown as WorkerDeps;
    const task = { payload: { jobId: near[0]!.id } } as never;
    const outcomes = await Promise.all([handleScoreJob(task, aiDeps), handleScoreJob(task, aiDeps), handleScoreJob(task, aiDeps)]);
    expect(scoreJob).toHaveBeenCalledTimes(1);
    expect(outcomes.filter((r) => (r as { skipped?: string }).skipped === "near-miss daily cap reached")).toHaveLength(2);
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
    const [decision] = await db.insert(schema.decisions).values({ jobId: job!.id, decision: "skip", reason: "Too junior", jobTitle: "Operations", companyName: "Acme", tags: [], tagsEdited: true }).returning();
    const tagReason = vi.fn();
    const modelDeps = { ...deps, ai: { ...deps.ai, enabled: true, tagReason } } as unknown as WorkerDeps;
    await handleTagReason({ payload: { decisionId: decision!.id } } as never, modelDeps);
    expect(tagReason).not.toHaveBeenCalled();
  });
});
