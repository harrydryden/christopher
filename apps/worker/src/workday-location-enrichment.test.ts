import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, enqueueStandard, reevaluateGate, schema, subscribeToCompany, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { sha1 } from "@ava/core";
import { eq, sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { _scanSourceForTests } from "./handlers/scan";
import { handleFetchLocations } from "./handlers/locations";
import { handleFetchDescription } from "./handlers/description";
import { onAbandon } from "./handlers/abandon";
import { TaskDeferred } from "./queue";
import { ensureTestUser } from "./test-users";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";
const host = "acme.wd1.myworkdayjobs.com";
const listingUrl = `https://${host}/wday/cxs/acme/Search/jobs`;
const detailUrl = `https://${host}/wday/cxs/acme/Search/job/US/Operations/JR-1`;
let deps: WorkerDeps;
let db: Db;
let now = new Date("2026-10-01T09:00:00Z");

beforeAll(async () => {
  const bootstrap = createDb(url, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();
  process.env.DATABASE_URL = url;
  process.env.AVA_DISABLE_BROWSER = "1";
  delete process.env.ANTHROPIC_API_KEY;
  deps = await createDeps(readEnv(), { now: () => now, settingsTtlMs: 0 });
  db = deps.db;
}, 60_000);

afterAll(async () => { await deps?.close(); });
beforeEach(async () => {
  await db.execute(sql`truncate users, companies, career_sources, discovery_runs, scan_runs, scans, jobs,
    job_events, decisions, tasks, settings, ai_calls, company_profiles, company_suggestions,
    filter_suggestions, preference_profiles, cv_libraries restart identity cascade`);
  now = new Date("2026-10-01T09:00:00Z");
});

async function fixture(locationTerms = ["Boston"], matchFields = ["title"], excludeKeywords: string[] = []) {
  const user = await ensureTestUser(db, "workday-location@example.com");
  await db.insert(schema.userSettings).values({ userId: user.id, key: "gate", value: {
    includeKeywords: ["operations"], excludeKeywords, matchFields,
    locationTerms, includeRemote: true,
  } });
  const [company] = await db.insert(schema.companies).values({ name: "Acme", domain: "acme.example",
    homepageUrl: "https://acme.example/" }).returning();
  await subscribeToCompany(db, user.id, company!.id);
  const [source] = await db.insert(schema.careerSources).values({ companyId: company!.id,
    type: "workday", url: `https://${host}/Search`, apiUrl: listingUrl, atsSlug: "acme",
    atsSite: `${host}|Search`, status: "active" }).returning();
  let detailMode: "ok" | "fail" = "ok";
  let listingLabel = "2 Locations";
  let detailAdditional = "Boston, Massachusetts, United States";
  let detailWait: Promise<void> | undefined;
  let descriptionWait: Promise<void> | undefined;
  const fetchText = vi.fn(async (requestUrl: string) => {
    if (requestUrl === detailUrl) {
      if (detailWait) await detailWait;
      if (detailMode === "fail") throw new Error("temporary Workday detail failure");
      const body = JSON.stringify({ jobPostingInfo: { location: "Atlanta, Georgia, United States",
        additionalLocations: [detailAdditional] } });
      return { url: requestUrl, status: 200, headers: {}, body, contentHash: sha1(body) };
    }
    if (requestUrl === `https://${host}/Search/job/US/Operations/JR-1`) {
      if (descriptionWait) await descriptionWait;
      const body = `<html><body><main><h1>Operations Manager</h1><p>${"Operations coordination and planning for regional teams. ".repeat(8)}</p></main></body></html>`;
      return { url: requestUrl, status: 200, headers: {}, body, contentHash: sha1(body) };
    }
    if (requestUrl !== listingUrl) throw new Error(`unexpected fetch ${requestUrl}`);
    const body = JSON.stringify({ total: 1, jobPostings: [{ title: "Operations Manager",
      externalPath: "/job/US/Operations/JR-1", locationsText: listingLabel, remoteType: "Remote",
      bulletFields: ["JR-1"] }] });
    return { url: requestUrl, status: 200, headers: {}, body, contentHash: sha1(body) };
  });
  const mocked = { ...deps, fetcher: { fetchText,
    fetchBytes: vi.fn(async () => { throw new Error("unexpected byte fetch"); }) } as unknown as WorkerDeps["fetcher"] };
  const scan = async () => _scanSourceForTests(mocked, company!,
    (await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source!.id)))[0]!,
    await deps.settings(), null);
  const job = async () => (await db.select().from(schema.jobs).where(eq(schema.jobs.sourceId, source!.id)))[0]!;
  const locationTask = async () => (await db.select().from(schema.tasks).where(eq(schema.tasks.type, "fetch_locations")))[0]!;
  return { user, company: company!, source: source!, mocked, fetchText, scan, job, locationTask,
    setDetailMode: (value: "ok" | "fail") => { detailMode = value; },
    setListingLabel: (value: string) => { listingLabel = value; },
    setDetailAdditional: (value: string) => { detailAdditional = value; },
    waitDetail: (value: Promise<void>) => { detailWait = value; },
    waitDescription: (value: Promise<void>) => { descriptionWait = value; } };
}

it("atomically queues one detail and admits Boston only after named locations resolve", async () => {
  const f = await fixture();
  expect((await f.scan()).status).toBe("ok");
  const before = await f.job();
  expect(before).toMatchObject({ location: null, locations: [], locationLabel: "2 Locations",
    locationResolution: "pending", remote: true });
  expect(await db.select().from(schema.userJobs)).toHaveLength(0);
  const task = await f.locationTask();
  expect(task.payload).toMatchObject({ jobId: before.id, locationRevision: before.locationRevision });
  expect(await handleFetchLocations(task, f.mocked)).toMatchObject({ resolved: true, locations: 2 });
  expect(await db.select().from(schema.userJobs)).toHaveLength(1);
  expect((await f.job()).locations).toContain("Boston, Massachusetts, United States");
  expect(f.fetchText.mock.calls.filter(([requestUrl]) => requestUrl === detailUrl)).toHaveLength(1);
  await db.delete(schema.tasks);
  await f.scan();
  expect((await f.job()).locationResolution).toBe("resolved");
  expect((await f.job()).locations).toContain("Boston, Massachusetts, United States");
  expect(await db.select().from(schema.tasks).where(eq(schema.tasks.type, "fetch_locations"))).toHaveLength(0);
});

it("excludes a UK follower after detail and retries an unavailable lookup", async () => {
  const f = await fixture(["UK"]);
  await f.scan();
  const task = await f.locationTask();
  f.setDetailMode("fail");
  await expect(handleFetchLocations(task, f.mocked)).rejects.toThrow("temporary Workday detail failure");
  expect((await f.job()).locationResolution).toBe("unavailable");
  expect((await f.job()).locationError).toContain("temporary Workday");
  expect((await f.job()).locationFetchedAt).toBeNull();
  f.setDetailMode("ok");
  expect(await handleFetchLocations(task, f.mocked)).toMatchObject({ resolved: true });
  expect((await f.job()).locationResolution).toBe("resolved");
  expect(await db.select().from(schema.userJobs)).toHaveLength(0);
});

it("refuses a late old detail after a newer listing revision", async () => {
  const f = await fixture();
  await f.scan();
  const task = await f.locationTask();
  let release!: () => void;
  let entered!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  f.waitDetail(new Promise<void>(resolve => { release = resolve; entered(); }));
  await arrived;
  const pending = handleFetchLocations(task, f.mocked);
  // Let the detail start before changing the listed role. Its response may arrive after any scan.
  await vi.waitFor(() => expect(f.fetchText.mock.calls.some(([requestUrl]) => requestUrl === detailUrl)).toBe(true));
  await db.update(schema.jobs).set({ locationRevision: "newer-revision", locationResolution: "resolved",
    location: "London, UK", locations: ["London, UK"] }).where(eq(schema.jobs.id, (await f.job()).id));
  release();
  expect(await pending).toMatchObject({ skipped: "newer location evidence won" });
  expect((await f.job()).location).toBe("London, UK");
});

it("retains previously verified names and a qualified view during a seven-day refresh", async () => {
  const f = await fixture();
  await f.scan();
  await handleFetchLocations(await f.locationTask(), f.mocked);
  const first = await f.job();
  await db.delete(schema.tasks);
  now = new Date("2026-10-09T09:00:00Z");
  await f.scan();
  const refreshing = await f.job();
  expect(refreshing.locationResolution).toBe("pending");
  expect(refreshing.locationRevision).not.toBe(first.locationRevision);
  expect(refreshing.locations).toEqual(first.locations);
  expect((await db.select().from(schema.userJobs))[0]).toMatchObject({ inTable: true, archivedAt: null });
  const next = await f.locationTask();
  expect((next.payload as { locationRevision: string }).locationRevision).toBe(refreshing.locationRevision);
  f.setDetailMode("fail");
  await expect(handleFetchLocations(next, f.mocked)).rejects.toThrow("temporary Workday detail failure");
  expect((await f.job()).locationFetchedAt).toEqual(first.locationFetchedAt);
  expect((await db.select().from(schema.userJobs))[0]).toMatchObject({ inTable: true, archivedAt: null });
  f.setDetailMode("ok");
  await handleFetchLocations(next, f.mocked);
  expect((await f.job()).locationResolution).toBe("resolved");
});

it("invalidates a previously scored unrestricted view once when named locations arrive", async () => {
  const f = await fixture([]);
  await f.scan();
  const [view] = await db.select().from(schema.userJobs);
  expect(view).toBeDefined();
  await db.update(schema.userJobs).set({ fitScore: 88, scoredAt: now, hidden: true })
    .where(eq(schema.userJobs.jobId, view!.jobId));
  const task = await f.locationTask();
  // An unrestricted follower has no location request of their own; a restricted follower added
  // later asks for the same shared detail. The task is queued by that new gate, not by scoring.
  expect(task).toBeUndefined();
  const restricted = await ensureTestUser(db, "workday-boston@example.com");
  await db.insert(schema.userSettings).values({ userId: restricted.id, key: "gate", value: {
    includeKeywords: ["operations"], excludeKeywords: [], matchFields: ["title"],
    locationTerms: ["Boston"], includeRemote: true,
  } });
  await subscribeToCompany(db, restricted.id, f.company.id);
  await reevaluateGate(db, restricted.id, await deps.userSettings(restricted.id), now, { companyId: f.company.id });
  const requested = await f.locationTask();
  expect(requested).toBeDefined();
  await handleFetchLocations(requested, f.mocked);
  const [after] = await db.select().from(schema.userJobs).where(eq(schema.userJobs.userId, f.user.id));
  expect(after).toMatchObject({ fitScore: null, scoredAt: null, hidden: true, inTable: true });
  expect((await db.select().from(schema.userJobs).where(eq(schema.userJobs.userId, restricted.id)))).toHaveLength(1);
  expect(await handleFetchLocations(requested, f.mocked)).toMatchObject({ skipped: "location revision is no longer pending" });
});

it("clears counted metadata when a later listing gives a named location", async () => {
  const f = await fixture();
  await f.scan();
  f.setListingLabel("London, UK");
  await db.delete(schema.tasks);
  await f.scan();
  expect(await f.job()).toMatchObject({ location: "London, UK", locations: ["London, UK"],
    locationResolution: null, locationLabel: null, locationRevision: null });
  expect(await db.select().from(schema.tasks).where(eq(schema.tasks.type, "fetch_locations"))).toHaveLength(0);
});

it("keeps location and description detail work independent for a description-only gate", async () => {
  const f = await fixture(["Boston"], ["description"]);
  await f.scan();
  // Both detail requests may proceed independently; neither waits on the other's gate verdict.
  const earlyLocationTask = await f.locationTask();
  expect(earlyLocationTask).toBeDefined();
  const [descriptionTask] = await db.select().from(schema.tasks).where(eq(schema.tasks.type, "fetch_description"));
  expect(descriptionTask).toBeDefined();
  await handleFetchDescription(descriptionTask!, f.mocked);
  expect((await f.job()).descriptionText).toContain("Operations coordination");
  expect(await db.select().from(schema.tasks).where(eq(schema.tasks.type, "fetch_locations"))).toHaveLength(1);
  expect(await db.select().from(schema.userJobs)).toHaveLength(0);
  await handleFetchLocations(earlyLocationTask, f.mocked);
  expect(await db.select().from(schema.userJobs)).toHaveLength(1);
});

it("does not request location detail for a description-only gate with a decisive title exclusion", async () => {
  const f = await fixture(["Boston"], ["description"], ["manager"]);
  await f.scan();
  expect((await f.job()).locationResolution).toBe("pending");
  expect(await f.locationTask()).toBeUndefined();
  expect(await db.select().from(schema.userJobs)).toHaveLength(0);
});

it("marks an abandoned pending revision unavailable but leaves a newer one alone", async () => {
  const f = await fixture();
  await f.scan();
  const task = await f.locationTask();
  await onAbandon.fetch_locations!(task, f.mocked, "worker stopped");
  expect(await f.job()).toMatchObject({ locationResolution: "unavailable",
    locationError: expect.stringContaining("worker stopped"), locationFetchedAt: null });
  await db.update(schema.jobs).set({ locationResolution: "pending", locationRevision: "newer-revision",
    locationError: null }).where(eq(schema.jobs.id, (await f.job()).id));
  await onAbandon.fetch_locations!(task, f.mocked, "older worker stopped");
  expect(await f.job()).toMatchObject({ locationResolution: "pending", locationError: null });
});

it("a late description uses the location detail that resolved while it was fetching", async () => {
  const f = await fixture();
  await f.scan();
  const job = await f.job();
  const descriptionId = await enqueueStandard(db, "fetch_description", { jobId: job.id });
  const [descriptionTask] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, descriptionId!));
  let release!: () => void;
  f.waitDescription(new Promise<void>(resolve => { release = resolve; }));
  const pendingDescription = handleFetchDescription(descriptionTask!, f.mocked);
  await vi.waitFor(() => expect(f.fetchText.mock.calls.some(([requestUrl]) =>
    requestUrl === `https://${host}/Search/job/US/Operations/JR-1`)).toBe(true));
  await handleFetchLocations(await f.locationTask(), f.mocked);
  expect((await db.select().from(schema.userJobs))[0]).toMatchObject({ inTable: true, archivedAt: null });
  release();
  await pendingDescription;
  expect((await db.select().from(schema.userJobs))[0]).toMatchObject({ inTable: true, archivedAt: null });
});

it("defers a location task at its source's hourly read cap without a detail request", async () => {
  const f = await fixture();
  await f.scan();
  const task = await f.locationTask();
  await db.insert(schema.workdayLocationReadBudgets).values({ sourceId: f.source.id,
    windowStartedAt: now, requestCount: 50 });
  const waiting = await handleFetchLocations(task, f.mocked);
  expect(waiting).toBeInstanceOf(TaskDeferred);
  expect((waiting as TaskDeferred).until).toEqual(new Date("2026-10-01T10:00:00Z"));
  expect(f.fetchText.mock.calls.filter(([requestUrl]) => requestUrl === detailUrl)).toHaveLength(0);
  expect((await f.job()).locationResolution).toBe("pending");
  now = new Date("2026-10-01T10:00:01Z");
  expect(await handleFetchLocations(task, f.mocked)).toMatchObject({ resolved: true });
  expect(f.fetchText.mock.calls.filter(([requestUrl]) => requestUrl === detailUrl)).toHaveLength(1);
});

it("re-evaluates secondary locations without invalidating a score on the unchanged primary place", async () => {
  const f = await fixture();
  await f.scan();
  await handleFetchLocations(await f.locationTask(), f.mocked);
  const [view] = await db.select().from(schema.userJobs);
  await db.update(schema.userJobs).set({ fitScore: 77, scoredAt: now })
    .where(eq(schema.userJobs.jobId, view!.jobId));
  await db.delete(schema.tasks);
  now = new Date("2026-10-09T09:00:00Z");
  await f.scan();
  f.setDetailAdditional("Seattle, Washington, United States");
  await handleFetchLocations(await f.locationTask(), f.mocked);
  const [after] = await db.select().from(schema.userJobs);
  expect(after!.fitScore).toBe(77);
  expect(after!.scoredAt).toEqual(new Date("2026-10-01T09:00:00Z"));
  expect(after!.inTable).toBe(false);
  expect(after!.archivedAt).not.toBeNull();
});
