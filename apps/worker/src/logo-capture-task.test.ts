/**
 * The logo as a piece of work the worker does: the task that captures one company's icon, and the
 * daily sweep that decides which companies are due one.
 *
 * What matters here is that a failure is a backoff rather than a failed task — an icon is
 * decoration, and a site that is down for an afternoon must not spend the queue's three attempts
 * in ten minutes and then give up for good — and that the sweep queues each company once.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createDb, readCompanyLogo, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { dedupeKeyFor } from "@ava/core";
import { eq, sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { handleDiscover } from "./handlers/discover";
import { handleRunDaily } from "./handlers/daily";
import { startTestServer, type TestServer } from "./test-server";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";
const HOSTS = ["www.logo.test", "logo.test", "blank.test", "icons.duckduckgo.com", "www.google.com"];
const DAY = 86_400_000;

let server: TestServer;
let deps: WorkerDeps;
let db: Db;
let now = new Date("2026-09-19T09:00:00Z");

function png(length = 400): Buffer {
  const bytes = Buffer.alloc(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let i = 8; i < length; i++) bytes[i] = i % 251;
  return bytes;
}

const robots = { body: "User-agent: *\nAllow: /\n", contentType: "text/plain" };

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();

  server = await startTestServer({
    "www.logo.test": {
      "/robots.txt": robots,
      "/": { body: `<!doctype html><html><head><title>Logo Ltd</title>
        <link rel="apple-touch-icon" href="/touch.png"></head><body>home</body></html>` },
      "/touch.png": { body: png(), contentType: "image/png" },
    },
    // A site that answers nothing: no page, no icon, and no icon service that knows it either.
    "blank.test": { "/robots.txt": { status: 404, body: "" } },
    "icons.duckduckgo.com": {},
    "www.google.com": {},
  }, HOSTS);

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
  await db.execute(sql`truncate users, companies, company_logos, career_sources, scan_runs, tasks, resource_leases, settings restart identity cascade`);
  now = new Date("2026-09-19T09:00:00Z");
});

async function company(overrides: Partial<typeof schema.companies.$inferInsert> = {}) {
  const domain = overrides.domain ?? "logo.test";
  const [row] = await db.insert(schema.companies).values({
    name: "Logo Ltd", domain, homepageUrl: `https://www.${domain}/`, ...overrides,
  }).returning();
  return row!;
}

const logoTask = (subject: { id: string; homepageUrl: string }) => ({
  id: "00000000-0000-0000-0000-000000000001",
  type: "discover",
  payload: { companyId: subject.id, logoOnly: true, homepageUrl: subject.homepageUrl },
  attempts: 1,
} as never);

const dailyTask = (trigger: "schedule" | "manual") => ({
  id: "00000000-0000-0000-0000-000000000002",
  type: "run_daily",
  payload: { trigger },
  result: null,
  attempts: 1,
} as never);

it("stores the icon a homepage declares, and says what it captured", async () => {
  const subject = await company({ logoAttempts: 4, logoError: "was failing", logoNextAttemptAt: new Date(now.getTime() - DAY) });

  const result = await handleDiscover(logoTask(subject), deps) as Record<string, unknown>;
  expect(result).toEqual({
    captured: true,
    source: "site_icon",
    sourceUrl: "https://www.logo.test/touch.png",
    bytes: 400,
    contentType: "image/png",
  });

  const stored = await readCompanyLogo(db, subject.id);
  expect(stored?.contentType).toBe("image/png");
  expect(stored?.bytes).toEqual(png());
  const [after] = await db.select().from(schema.companies).where(eq(schema.companies.id, subject.id));
  // The capture is the retry state's answer: attempts back to zero, no backoff, no error.
  expect(after).toMatchObject({ logoAttempts: 0, logoNextAttemptAt: null, logoError: null, faviconUrl: "https://www.logo.test/touch.png" });
  expect(after!.logoFetchedAt?.toISOString()).toBe(now.toISOString());
});

it("records a failure as a backoff, and finishes the task rather than failing it", async () => {
  const subject = await company({ domain: "blank.test", homepageUrl: "https://blank.test/" });

  const result = await handleDiscover(logoTask(subject), deps) as { captured: boolean; error: string; attempts: number; nextAttemptAt: Date; tried: number };
  expect(result.captured).toBe(false);
  expect(result.error).toContain("No usable icon found for blank.test");
  expect(result.attempts).toBe(1);
  // An hour, not the queue's few minutes: the retry policy for a logo is the stored backoff.
  expect(result.nextAttemptAt.toISOString()).toBe(new Date(now.getTime() + 3_600_000).toISOString());
  expect(result.tried).toBeGreaterThan(0);

  const [after] = await db.select().from(schema.companies).where(eq(schema.companies.id, subject.id));
  expect(after!.logoAttempts).toBe(1);
  expect(after!.logoError).toContain("No usable icon");
  expect(after!.logoNextAttemptAt?.toISOString()).toBe(result.nextAttemptAt.toISOString());
  expect(after!.logoFetchedAt).toBeNull();
  expect(await readCompanyLogo(db, subject.id)).toBeNull();
});

it("leaves a company alone when its homepage changed while the capture was in flight", async () => {
  const subject = await company();
  const stale = { id: subject.id, homepageUrl: "https://www.was-this.test/" };
  expect(await handleDiscover(logoTask(stale), deps)).toEqual({ skipped: "homepage changed" });
  expect(await readCompanyLogo(db, subject.id)).toBeNull();
});

it("sweeps the companies that are due a logo into the daily run, once each", async () => {
  const never = await company({ domain: "logo.test" });
  const stale = await company({ domain: "stale.test", logoFetchedAt: new Date(now.getTime() - 120 * DAY) });
  const fresh = await company({ domain: "fresh.test", logoFetchedAt: new Date(now.getTime() - DAY) });
  const backingOff = await company({ domain: "backoff.test", logoAttempts: 2, logoNextAttemptAt: new Date(now.getTime() + 6 * 3_600_000) });

  const first = await handleRunDaily(dailyTask("manual"), deps) as { logosQueued: number };
  expect(first.logosQueued).toBe(2);

  const queued = await db.select().from(schema.tasks).where(eq(schema.tasks.type, "discover"));
  const companiesQueued = queued.map(t => (t.payload as { companyId: string }).companyId).sort();
  expect(companiesQueued).toEqual([never.id, stale.id].sort());
  expect(queued.every(t => t.priority === 6)).toBe(true);
  expect(queued.every(t => (t.payload as { logoOnly?: boolean }).logoOnly === true)).toBe(true);
  expect(queued.find(t => (t.payload as { companyId: string }).companyId === never.id)?.dedupeKey)
    .toBe(dedupeKeyFor("discover", { companyId: never.id, logoOnly: true, homepageUrl: never.homepageUrl }));
  expect(companiesQueued).not.toContain(fresh.id);
  expect(companiesQueued).not.toContain(backingOff.id);

  // An hour later, with the first sweep's tasks still queued: the dedupe key adds nothing.
  now = new Date(now.getTime() + 3_600_000);
  const second = await handleRunDaily(dailyTask("manual"), deps) as { logosQueued: number };
  expect(second.logosQueued).toBe(0);
  expect(await db.select().from(schema.tasks).where(eq(schema.tasks.type, "discover"))).toHaveLength(2);

  // And once a failing company's backoff has passed, the sweep asks for it again.
  now = new Date(now.getTime() + 12 * 3_600_000);
  const third = await handleRunDaily(dailyTask("manual"), deps) as { logosQueued: number };
  expect(third.logosQueued).toBe(1);
  const all = await db.select().from(schema.tasks).where(eq(schema.tasks.type, "discover"));
  expect(all.map(t => (t.payload as { companyId: string }).companyId)).toContain(backingOff.id);
});
