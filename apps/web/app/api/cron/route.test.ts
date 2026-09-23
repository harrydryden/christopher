/**
 * The cron route is the whole scheduler for a deployment without a worker service, so it is
 * tested against a real database and the local fake company site: it must refuse an unsigned
 * call, then discover a careers source and scan it with no worker process involved.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, enqueueTask, schema, subscribeToCompany, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { dedupeKeyFor, priorityFor } from "@ava/core";
import type { HandlerMap } from "@ava/worker";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { signInTestUser } from "@/test/auth";
import { startTestServer, type TestServer } from "../../../../worker/src/test-server";
import { ensureTestUser } from "../../../../worker/src/test-users";

/** The session cookie the next request carries, if any. */
let sessionCookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "ava_session" && sessionCookie ? { value: sessionCookie } : undefined) }),
  headers: async () => new Headers(),
}));

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";
const SECRET = "cron-test-secret";

const JOBS = {
  jobs: [
    { id: 1, title: "Operations Manager", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/1", location: { name: "London, UK" }, first_published: "2026-09-04T00:00:00Z", departments: [{ name: "Operations" }] },
    { id: 2, title: "Software Engineer", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/2", location: { name: "London, UK" }, first_published: "2026-09-01T00:00:00Z", departments: [{ name: "Engineering" }] },
  ],
};

const SITE = {
  "/": {
    body: `<html><head><title>Acme Robotics</title><meta property="og:site_name" content="Acme Robotics"></head>
      <body><nav><a href="/">Home</a><a href="/product">Product</a><a href="/blog">Blog</a>
      <a href="/about">About</a><a href="/careers">Careers</a></nav></body></html>`,
  },
  "/careers": {
    body: `<html><body><ul>
      <li><a href="https://job-boards.greenhouse.io/acme/jobs/1">Operations Manager</a><span>London, UK</span></li>
      <li><a href="https://job-boards.greenhouse.io/acme/jobs/2">Software Engineer</a><span>London, UK</span></li>
      </ul></body></html>`,
  },
  "/robots.txt": { body: "User-agent: *\nAllow: /\n", contentType: "text/plain" },
};

let server: TestServer;
let db: Db;
let pool: { end(): Promise<void> };
let GET: (request: Request) => Promise<Response>;
let POST: (request: Request) => Promise<Response>;
let runScheduledWork: typeof import("./scheduled-work").runScheduledWork;

beforeAll(async () => {
  process.env.AVA_SERVERLESS_FALLBACK = "1";
  server = await startTestServer(
    {
      "www.acme.example": SITE,
      "acme.example": SITE,
      "boards-api.greenhouse.io": {
        "/v1/boards/acme/jobs": { body: JOBS },
        "/v1/boards/acme": { body: { name: "Acme Robotics" } },
      },
      "job-boards.greenhouse.io": {},
    },
    ["www.acme.example", "acme.example", "boards-api.greenhouse.io", "job-boards.greenhouse.io"],
  );

  process.env.DATABASE_URL = DATABASE_URL;
  process.env.CRON_SECRET = SECRET;
  process.env.AVA_HOST_MAP = JSON.stringify(server.hostMap);
  process.env.AVA_DISABLE_BROWSER = "1";
  process.env.SCRAPER_CONTACT_EMAIL = "you@example.com";
  delete process.env.ANTHROPIC_API_KEY;
  process.env.SESSION_SECRET = "cron-test-session-secret";

  ({ GET, POST } = await import("./route"));
  ({ runScheduledWork } = await import("./scheduled-work"));

  const created = createDb(DATABASE_URL, { max: 2 });
  db = created.db;
  pool = created.pool;
  await runMigrations(db);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await server?.close();
});

beforeEach(async () => {
  sessionCookie = undefined;
  await db.execute(sql`truncate companies, career_sources, discovery_runs, scan_runs, scans, jobs, job_events, decisions, tasks, settings, ai_calls, users restart identity cascade`);
});

function call(secret?: string) {
  return GET(new Request("https://example.test/api/cron", secret ? { headers: { authorization: `Bearer ${secret}` } } : undefined));
}

/** A request from a signed-in browser: the cookie rides along, and a POST names the page's origin. */
function fromBrowser(method: "GET" | "POST", origin?: string) {
  const request = new Request("https://example.test/api/cron", { method, headers: origin ? { origin } : {} });
  return method === "GET" ? GET(request) : POST(request);
}

/** The daily run is due, so any call that gets as far as the scheduler tick queues it. */
async function dailyRunDue() {
  await db.insert(schema.settings).values([
    { key: "scanTime", value: "00:00" },
    { key: "timezone", value: "UTC" },
  ]);
}

async function enqueueTagReason(maxAttempts?: number) {
  const payload = { decisionId: randomUUID() };
  const id = await enqueueTask(db, "tag_reason", payload, { dedupeKey: dedupeKeyFor("tag_reason", payload), priority: priorityFor("tag_reason"), maxAttempts });
  return id!;
}

const taskRow = async (id: string) => (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!;

/** Handlers for the fallback tests: the daily run does nothing, and `tag_reason` is the test's own. */
const fakeHandlers = (tagReason: NonNullable<HandlerMap["tag_reason"]>): HandlerMap => ({ run_daily: async () => undefined, tag_reason: tagReason });

describe("the cron route", () => {
  it("refuses a call with no secret, and one with the wrong secret", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("not-the-secret")).status).toBe(401);
    expect((await fromBrowser("POST", "https://example.test")).status).toBe(401);
  });

  it("refuses a member's session on either method, and runs nothing", async () => {
    await dailyRunDue();
    ({ cookie: sessionCookie } = await signInTestUser(db, process.env.SESSION_SECRET!, "member@example.com", "member"));
    const viaGet = await fromBrowser("GET");
    expect(viaGet.status).toBe(403);
    expect(await viaGet.json()).toEqual({ ok: false, error: "administrators only" });
    expect((await fromBrowser("POST", "https://example.test")).status).toBe(403);
    expect(await db.select().from(schema.tasks)).toHaveLength(0);
  });

  it("never starts a run from an administrator's session through GET, which a cross-site link can trigger", async () => {
    await dailyRunDue();
    ({ cookie: sessionCookie } = await signInTestUser(db, process.env.SESSION_SECRET!, "admin@example.com", "admin"));
    const response = await fromBrowser("GET");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    // The scheduler never ticked: the due daily run was not queued.
    expect(await db.select().from(schema.tasks)).toHaveLength(0);
  });

  it("refuses an administrator's POST from another site, and runs one from this site", async () => {
    await dailyRunDue();
    ({ cookie: sessionCookie } = await signInTestUser(db, process.env.SESSION_SECRET!, "admin@example.com", "admin"));
    expect((await fromBrowser("POST", "https://evil.example")).status).toBe(403);
    expect((await fromBrowser("POST")).status).toBe(403);
    expect(await db.select().from(schema.tasks)).toHaveLength(0);

    const response = await fromBrowser("POST", "https://example.test");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect((await db.select().from(schema.scanRuns)).map(run => run.trigger)).toEqual(["schedule"]);
  }, 120_000);

  it("accepts the bearer token on POST as well as GET", async () => {
    const response = await POST(new Request("https://example.test/api/cron", { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }));
    expect(response.status).toBe(200);
  }, 120_000);

  it("answers a failure without the error's own text", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.DATABASE_URL = "postgres://nobody:not-the-password@127.0.0.1:1/none";
    try {
      const response = await call(SECRET);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ ok: false, error: "scheduled run failed" });
      expect(logged.mock.calls.some(([line]) => String(line).includes("cron_failed"))).toBe(true);
    } finally {
      process.env.DATABASE_URL = DATABASE_URL;
      logged.mockRestore();
    }
  });

  it("never claims a CV build, which no single invocation can finish", async () => {
    const id = await enqueueTask(db, "generate_cv", { draftId: randomUUID() }, { priority: priorityFor("generate_cv") });
    const body = (await (await call(SECRET)).json()) as { ok: boolean; byType: Record<string, number> };
    expect(body.ok).toBe(true);
    expect(body.byType.generate_cv).toBeUndefined();
    expect(await taskRow(id!)).toMatchObject({ status: "queued", attempts: 0, lockedBy: null });
  }, 120_000);

  it("cuts off a task that would outlast the invocation, and puts it back on the queue with the attempt counted", async () => {
    const id = await enqueueTagReason();
    let aborted = false;
    const interrupted = vi.fn(async (_task: unknown, _deps: unknown, _info: { retryAt?: string }) => undefined);
    const result = await runScheduledWork({
      hardStopMs: 3_000,
      claimForMs: 2_000,
      // A handler that never finishes on its own: only the run's signal ends it.
      handlers: fakeHandlers((_task, _deps, { signal }) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
      })),
      onInterrupted: { tag_reason: interrupted },
    });
    expect(result).toMatchObject({ timedOut: true, drained: true });
    expect(result.durationMs).toBeLessThan(3_000 + 2_000);
    expect(aborted).toBe(true);
    const row = await taskRow(id);
    expect(row).toMatchObject({ status: "queued", attempts: 1 });
    expect(row.error).toMatch(/deadline/);
    // The type's hook is told the run was cut off and when the next attempt is due.
    expect(interrupted).toHaveBeenCalledTimes(1);
    expect(interrupted.mock.calls[0]![2]).toMatchObject({ retryAt: expect.any(String) });
  }, 120_000);

  it("closes off a task that fails on its last attempt with the type's abandon hook", async () => {
    const id = await enqueueTagReason(3);
    await db.update(schema.tasks).set({ attempts: 2 }).where(eq(schema.tasks.id, id));
    const abandoned = vi.fn(async (_task: unknown, _deps: unknown, _reason: string) => undefined);
    await runScheduledWork({
      hardStopMs: 30_000,
      claimForMs: 20_000,
      handlers: fakeHandlers(async () => { throw new Error("tagging failed"); }),
      onAbandon: { tag_reason: abandoned },
    });
    expect(await taskRow(id)).toMatchObject({ status: "failed", attempts: 3 });
    expect(abandoned).toHaveBeenCalledTimes(1);
    expect(abandoned.mock.calls[0]![2]).toBe("tagging failed");
  }, 120_000);

  it("leaves the schedule and the queue to a recently reporting persistent worker", async () => {
    // The daily run is due, and a task is waiting: beside a healthy worker this route does neither.
    await db.insert(schema.settings).values([
      { key: "internal:workerHeartbeat", value: { at: new Date().toISOString() } },
      { key: "scanTime", value: "00:00" },
      { key: "timezone", value: "UTC" },
    ]);
    const [company] = await db
      .insert(schema.companies)
      .values({ name: "acme.example", homepageUrl: "https://www.acme.example/", domain: "acme.example" })
      .returning();
    await enqueueTask(db, "discover", { companyId: company!.id, reason: "added" }, {
      dedupeKey: dedupeKeyFor("discover", { companyId: company!.id }),
      priority: priorityFor("discover"),
    });

    const response = await call(SECRET);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; processed: number; standDown?: string };
    expect(body).toMatchObject({ ok: true, processed: 0, standDown: "worker" });
    // No scheduler tick either: the daily run is the worker's to queue.
    const tasks = await db.select().from(schema.tasks);
    expect(tasks.map((task) => task.type)).toEqual(["discover"]);
    expect(tasks[0]!.status).toBe("queued");
    expect(await db.select().from(schema.scanRuns)).toHaveLength(0);
  });

  it("schedules but does not drain when the fallback is off", async () => {
    delete process.env.AVA_SERVERLESS_FALLBACK;
    try {
      await db.insert(schema.settings).values([
        { key: "scanTime", value: "00:00" },
        { key: "timezone", value: "UTC" },
      ]);
      const [company] = await db
        .insert(schema.companies)
        .values({ name: "acme.example", homepageUrl: "https://www.acme.example/", domain: "acme.example" })
        .returning();
      await enqueueTask(db, "discover", { companyId: company!.id, reason: "added" }, {
        dedupeKey: dedupeKeyFor("discover", { companyId: company!.id }),
        priority: priorityFor("discover"),
      });
      const body = (await (await call(SECRET)).json()) as { processed: number; drained?: boolean };
      expect(body).toMatchObject({ processed: 0, drained: false });
      // The tick queues the day's work; with no worker and no fallback, nothing runs it.
      const tasks = await db.select().from(schema.tasks);
      expect(tasks.map((task) => task.type).sort()).toEqual(["discover", "run_daily"]);
      expect(tasks.every((task) => task.status === "queued")).toBe(true);
      expect(await db.select().from(schema.scanRuns)).toHaveLength(0);
    } finally {
      process.env.AVA_SERVERLESS_FALLBACK = "1";
    }
  }, 120_000);

  it("discovers a careers source and scans it, with no worker running", async () => {
    const [company] = await db
      .insert(schema.companies)
      .values({ name: "acme.example", homepageUrl: "https://www.acme.example/", domain: "acme.example" })
      .returning();
    const user = await ensureTestUser(db);
    await subscribeToCompany(db, user.id, company!.id);
    await enqueueTask(db, "discover", { companyId: company!.id, reason: "added" }, {
      dedupeKey: dedupeKeyFor("discover", { companyId: company!.id }),
      priority: priorityFor("discover"),
    });

    const response = await call(SECRET);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; processed: number; byType: Record<string, number> };
    expect(body.ok).toBe(true);
    expect(body.byType.discover).toBe(2); // Careers discovery plus its independent logo lookup.
    expect(body.byType.scan_company).toBeGreaterThanOrEqual(1);

    const [source] = await db.select().from(schema.careerSources);
    expect(source!.type).toBe("greenhouse");
    expect(source!.atsSlug).toBe("acme");

    // Every observed posting is stored once in the shared catalogue; only the follower's match gets a view.
    const jobs = await db.select().from(schema.jobs);
    expect(jobs.map((j) => j.title).sort()).toEqual(["Operations Manager", "Software Engineer"]);
    expect(jobs.find((j) => j.title === "Operations Manager")!.location).toBe("London, UK");
    const views = await db.select().from(schema.userJobs);
    expect(views.filter((v) => v.inTable).map((v) => jobs.find((j) => j.id === v.jobId)!.title)).toEqual(["Operations Manager"]);
  }, 120_000);

  it("queues the daily run once the local time has passed the configured hour", async () => {
    await db.insert(schema.settings).values([
      { key: "scanTime", value: "00:00" },
      { key: "timezone", value: "UTC" },
    ]);
    const response = await call(SECRET);
    expect(response.status).toBe(200);
    const runs = await db.select().from(schema.scanRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe("schedule");
  }, 120_000);
});
