/**
 * Discovery as a task: a run row that always ends, a result the host would not answer for yet that
 * is retried rather than recorded as nothing found, and a suggestion's verification that is shared
 * by every account asking about the same domain.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createDb, schema, type Db, type Task } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { DiscoveryRetryError, handleDiscover, onDiscoverAbandoned } from "./handlers/discover";
import { verifyCandidate } from "./handlers/companies";
import { LeaseLostError } from "./lease";
import { ensureTestUser } from "./test-users";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";
const now = new Date("2026-09-19T09:00:00Z");
const GH_JOBS = "https://boards-api.greenhouse.io/v1/boards/acme/jobs";

let base: WorkerDeps;
let db: Db;
let routes: Record<string, { status?: number; body: string | object }> = {};
let requested: string[] = [];

/** Every request answered from `routes`, 404 otherwise: no network, no pacing. */
const fetcher = {
  fetchText: async (url: string) => {
    requested.push(url);
    const route = routes[url];
    const body = route ? (typeof route.body === "string" ? route.body : JSON.stringify(route.body)) : "not found";
    return { status: route ? route.status ?? 200 : 404, url, headers: {}, body };
  },
  fetchBytes: async () => {
    throw new Error("no binary fetches in these tests");
  },
};

function deps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return { ...base, fetcher: fetcher as unknown as WorkerDeps["fetcher"], ...overrides };
}

function discoverTask(companyId: string, attempts = 1): Task {
  return { id: "00000000-0000-4000-8000-000000000001", type: "discover", payload: { companyId }, attempts, maxAttempts: 3, createdAt: new Date(now.getTime() - 60_000) } as unknown as Task;
}

async function company(domain = "acme.test") {
  const [row] = await db.insert(schema.companies).values({ name: "Acme", domain, homepageUrl: `https://www.${domain}/` }).returning();
  return row!;
}

async function runs(companyId: string) {
  return db.select().from(schema.discoveryRuns).where(eq(schema.discoveryRuns.companyId, companyId));
}

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AVA_DISABLE_BROWSER = "1";
  delete process.env.ANTHROPIC_API_KEY;
  base = await createDeps(readEnv(), { now: () => now, settingsTtlMs: 0 });
  db = base.db;
}, 60_000);

afterAll(async () => {
  await base?.close();
});

beforeEach(async () => {
  await db.execute(sql`truncate users, companies, career_sources, discovery_runs, verification_cache, tasks, resource_leases, settings, user_settings restart identity cascade`);
  requested = [];
  routes = {
    "https://www.acme.test/": { body: '<html><head><title>Acme</title></head><body><a href="https://boards.greenhouse.io/acme">Careers</a></body></html>' },
  };
});

it("retries a discovery whose only board could not be verified for now, and records it on the last attempt", async () => {
  routes[GH_JOBS] = { status: 503, body: "unavailable" };
  const acme = await company();
  await expect(handleDiscover(discoverTask(acme.id, 1), deps())).rejects.toBeInstanceOf(DiscoveryRetryError);
  const [first] = await runs(acme.id);
  // Nothing was found only because the host asked us to come back: that is not "not found".
  expect(first).toMatchObject({ status: "failed" });
  expect(first!.error).toContain("retrying: greenhouse/acme could not be verified for now");

  const outcome = await handleDiscover(discoverTask(acme.id, 3), deps()) as { outcome: string };
  expect(outcome.outcome).toBe("not_found");
  expect((await runs(acme.id)).map((run) => run.status).sort()).toEqual(["failed", "not_found"]);
});

it("records a board that is gone as the answer and does not retry", async () => {
  routes[GH_JOBS] = { status: 404, body: "gone" };
  const acme = await company();
  const outcome = await handleDiscover(discoverTask(acme.id, 1), deps()) as { outcome: string };
  expect(outcome.outcome).toBe("not_found");
  expect((await runs(acme.id)).map((run) => run.status)).toEqual(["not_found"]);
});

it("never leaves a run running when its result cannot be recorded", async () => {
  routes[GH_JOBS] = { body: { jobs: [{ id: 1, title: "Operations Lead", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/1", location: { name: "London" } }] } };
  routes["https://boards-api.greenhouse.io/v1/boards/acme"] = { body: { name: "Acme" } };
  const acme = await company();
  const lost = deps({ assertOwnership: async () => { throw new LeaseLostError("task reclaimed"); } });
  await expect(handleDiscover(discoverTask(acme.id), lost)).rejects.toBeInstanceOf(LeaseLostError);
  const [run] = await runs(acme.id);
  expect(run).toMatchObject({ status: "failed", error: "task reclaimed" });
  expect(run!.finishedAt).not.toBeNull();
});

it("stops discovering once its task is cancelled", async () => {
  const acme = await company();
  const controller = new AbortController();
  controller.abort();
  const outcome = await handleDiscover(discoverTask(acme.id), deps(), { signal: controller.signal }) as { outcome: string };
  expect(outcome.outcome).toBe("not_found");
  expect(requested).toEqual([]);
});

it("fails the runs an abandoned attempt left running, and orphans older than any discovery", async () => {
  const acme = await company();
  const other = await company("other.test");
  const [orphan] = await db.insert(schema.discoveryRuns).values({ companyId: acme.id, status: "running", startedAt: new Date(now.getTime() - 3_600_000) }).returning();
  const [elsewhere] = await db.insert(schema.discoveryRuns).values({ companyId: other.id, status: "running", startedAt: now }).returning();

  // A new discovery of the company closes the orphan a dead process left behind.
  routes[GH_JOBS] = { status: 404, body: "gone" };
  await handleDiscover(discoverTask(acme.id), deps());
  const [closed] = await db.select().from(schema.discoveryRuns).where(eq(schema.discoveryRuns.id, orphan!.id));
  expect(closed).toMatchObject({ status: "failed", error: "discovery did not finish" });

  // The abandonment hook fails what this task's attempts left running, and nothing of another company's.
  const [left] = await db.insert(schema.discoveryRuns).values({ companyId: acme.id, status: "running", startedAt: now }).returning();
  await onDiscoverAbandoned(discoverTask(acme.id, 3), deps(), "deadline exceeded");
  const [abandoned] = await db.select().from(schema.discoveryRuns).where(eq(schema.discoveryRuns.id, left!.id));
  expect(abandoned!.status).toBe("failed");
  expect(abandoned!.error).toContain("deadline exceeded");
  const [untouched] = await db.select().from(schema.discoveryRuns).where(eq(schema.discoveryRuns.id, elsewhere!.id));
  expect(untouched!.status).toBe("running");
});

it("verifies a suggested domain once for every account, and counts matches with each account's own gate", async () => {
  routes = {
    "https://acme.test/": { body: '<html><head><title>Acme</title></head><body><a href="https://boards.greenhouse.io/acme">Careers</a></body></html>' },
    [GH_JOBS]: { body: { jobs: [
      { id: 1, title: "Operations Lead", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/1", location: { name: "London" } },
      { id: 2, title: "Software Engineer", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/2", location: { name: "London" } },
      { id: 3, title: "Operations Analyst", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/3", location: { name: "London" } },
    ] } },
    "https://boards-api.greenhouse.io/v1/boards/acme": { body: { name: "Acme" } },
  };
  const operations = await ensureTestUser(db, "ops@example.com");
  const engineering = await ensureTestUser(db, "eng@example.com");
  for (const [user, keyword] of [[operations, "operations"], [engineering, "engineer"]] as const) {
    const value = { includeKeywords: [keyword], excludeKeywords: [], matchFields: ["title"], locationTerms: [], includeRemote: true };
    await db.insert(schema.userSettings).values({ userId: user.id, key: "gate", value });
  }
  const first = await verifyCandidate(deps(), operations.id, "https://acme.test/", true);
  const homepageReads = requested.filter((url) => url === "https://acme.test/").length;
  const second = await verifyCandidate(deps(), engineering.id, "https://acme.test/", true);
  expect(first).toMatchObject({ homepageOk: true, careersSource: { type: "greenhouse" }, openRoles: 3, matchingRoles: 2 });
  expect(second).toMatchObject({ homepageOk: true, careersSource: { type: "greenhouse" }, openRoles: 3, matchingRoles: 1 });
  // The second account's verification was the cached one: not one more request.
  expect(requested.filter((url) => url === "https://acme.test/")).toHaveLength(homepageReads);
  expect(await db.select().from(schema.verificationCache)).toHaveLength(1);
});

it("caches a permanent verification failure and never a transient one", async () => {
  const user = await ensureTestUser(db, "ops@example.com");
  routes = { "https://gone.test/": { status: 404, body: "missing" } };
  expect(await verifyCandidate(deps(), user.id, "https://gone.test/", true)).toEqual({ homepageOk: false, error: "HTTP 404" });
  routes = { "https://busy.test/": { status: 503, body: "later" } };
  expect(await verifyCandidate(deps(), user.id, "https://busy.test/", true)).toMatchObject({ homepageOk: false, transient: true });
  const cached = await db.select().from(schema.verificationCache);
  expect(cached.map((row) => row.result)).toEqual([{ homepageOk: false, error: "HTTP 404" }]);
});
