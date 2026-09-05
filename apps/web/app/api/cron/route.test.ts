/**
 * The cron route is the whole scheduler for a deployment without a worker service, so it is
 * tested against a real database and the local fake company site: it must refuse an unsigned
 * call, then discover a careers source and scan it with no worker process involved.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, enqueueTask, schema, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { dedupeKeyFor, priorityFor } from "@christopher/core";
import { sql } from "drizzle-orm";
import { startTestServer, type TestServer } from "../../../../worker/src/test-server";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test";
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

beforeAll(async () => {
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
  process.env.CHRISTOPHER_HOST_MAP = JSON.stringify(server.hostMap);
  process.env.CHRISTOPHER_DISABLE_BROWSER = "1";
  process.env.SCRAPER_CONTACT_EMAIL = "you@example.com";
  delete process.env.ANTHROPIC_API_KEY;

  ({ GET } = await import("./route"));

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
  await db.execute(sql`truncate companies, career_sources, discovery_runs, scan_runs, scans, jobs, job_events, decisions, tasks, settings, ai_calls restart identity cascade`);
});

function call(secret?: string) {
  return GET(new Request("https://example.test/api/cron", secret ? { headers: { authorization: `Bearer ${secret}` } } : undefined));
}

describe("the cron route", () => {
  it("refuses a call with no secret, and one with the wrong secret", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("not-the-secret")).status).toBe(401);
  });

  it("discovers a careers source and scans it, with no worker running", async () => {
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
    const body = (await response.json()) as { ok: boolean; processed: number; byType: Record<string, number> };
    expect(body.ok).toBe(true);
    expect(body.byType.discover).toBe(1);
    expect(body.byType.scan_company).toBeGreaterThanOrEqual(1);

    const [source] = await db.select().from(schema.careerSources);
    expect(source!.type).toBe("greenhouse");
    expect(source!.atsSlug).toBe("acme");

    const jobs = await db.select().from(schema.jobs);
    expect(jobs).toHaveLength(2);
    expect(jobs.filter((j) => j.inTable).map((j) => j.title)).toEqual(["Operations Manager"]);
    expect(jobs.find((j) => j.title === "Operations Manager")!.location).toBe("London, UK");
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
