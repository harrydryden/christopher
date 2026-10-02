import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, enqueueTask, schema, subscribeToCompany, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import { sha1 } from "@ava/core";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { handleScanCompany } from "./handlers/scan";
import { TaskDeferred } from "./queue";
import { ensureTestUser } from "./test-users";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";
let deps: WorkerDeps;
let db: Db;
let clock = new Date("2026-09-05T06:00:00Z");

beforeAll(async () => {
  const bootstrap = createDb(url, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();
  process.env.DATABASE_URL = url;
  process.env.AVA_DISABLE_BROWSER = "1";
  delete process.env.ANTHROPIC_API_KEY;
  deps = await createDeps(readEnv(), { now: () => clock, settingsTtlMs: 0 });
  db = deps.db;
}, 60_000);

afterAll(async () => { await deps?.close(); });
beforeEach(async () => {
  await db.execute(sql`truncate users, companies, career_sources, discovery_runs, scan_runs, scans, jobs, job_events, decisions, tasks, settings, ai_calls, company_profiles, company_suggestions, filter_suggestions, preference_profiles, cv_libraries restart identity cascade`);
  clock = new Date("2026-09-05T06:00:00Z");
});

function listing(page: number, total = 21, title = `Operations Role ${page + 1}`) {
  const next = page + 1 < total ? `<a rel="next" href="/listing?page=${page + 1}">Next page</a>` : "";
  return `<html><body><main><p>${page + 1} - ${page + 1} of ${total} results</p><ul class="jobs"><li><a href="/jobs/role-${page + 1}">${title}</a></li></ul>${next}</main></body></html>`;
}

async function fixture() {
  const user = await ensureTestUser(db, "partial-adversarial@example.com");
  const [company] = await db.insert(schema.companies).values({ name: "Pager", domain: "pager.example", homepageUrl: "https://pager.example/" }).returning();
  const [source] = await db.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://pager.example/listing?page=0", status: "active" }).returning();
  await subscribeToCompany(db, user.id, company!.id);
  await db.insert(schema.userSettings).values({ userId: user.id, key: "gate", value: {
    includeKeywords: ["operations"], excludeKeywords: [], matchFields: ["title"], locationTerms: [], includeRemote: true,
  } });
  const id = await enqueueTask(db, "scan_company", { companyId: company!.id, trigger: "manual" });
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id!));
  const fetchText = vi.fn(async (requestUrl: string) => {
    const page = Number(new URL(requestUrl).searchParams.get("page") ?? "0");
    const body = listing(page);
    return { url: requestUrl, status: 200, headers: {}, body, contentHash: sha1(body) };
  });
  const fastDeps = { ...deps, fetcher: { fetchText, fetchBytes: vi.fn(async () => { throw new Error("unexpected byte fetch"); }) } as unknown as WorkerDeps["fetcher"] };
  return { company: company!, source: source!, task: task!, fastDeps, fetchText };
}

it("queues detail work for roles published before the listing finishes", async () => {
  const { source, task, fastDeps } = await fixture();
  expect(await handleScanCompany(task, fastDeps)).toBeInstanceOf(TaskDeferred);
  expect(await db.select().from(schema.jobs).where(eq(schema.jobs.sourceId, source.id))).toHaveLength(20);
  expect(await db.select().from(schema.userJobs)).toHaveLength(20);
  const descriptions = await db.select().from(schema.tasks).where(eq(schema.tasks.type, "fetch_description"));
  expect(descriptions).toHaveLength(20);
  expect(await db.select().from(schema.scans).where(eq(schema.scans.sourceId, source.id))).toHaveLength(0);
}, 60_000);

it("does not count an old generation's absence against a role seen by a newer partial scan", async () => {
  const { company, source, task, fastDeps } = await fixture();
  expect(await handleScanCompany(task, fastDeps)).toBeInstanceOf(TaskDeferred);
  clock = new Date("2026-09-06T06:00:00Z");
  // A later partial scan proves this extra role exists, but does not change last_ok_scan_at.
  const [fresh] = await db.insert(schema.jobs).values({ companyId: company.id, sourceId: source.id,
    externalKey: "url:https://pager.example/jobs/fresh", title: "Fresh Operations Role",
    normalizedTitle: "fresh operations role", url: "https://pager.example/jobs/fresh",
    lastSeenAt: clock, missingScans: 1, firstMissedAt: new Date("2026-09-05T05:00:00Z") }).returning();
  expect((await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source.id)))[0]!.lastOkScanAt).toBeNull();
  await handleScanCompany(task, fastDeps);
  const [after] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, fresh!.id));
  expect(after).toMatchObject({ status: "open", missingScans: 1 });
  expect((await db.select().from(schema.jobEvents).where(and(eq(schema.jobEvents.jobId, fresh!.id), eq(schema.jobEvents.type, "closed"))))).toHaveLength(0);
}, 60_000);

it("keeps a newer fetched description when an older staged page is published later", async () => {
  const { company, source, task, fastDeps } = await fixture();
  expect(await handleScanCompany(task, fastDeps)).toBeInstanceOf(TaskDeferred);
  let checks = 0;
  await expect(handleScanCompany(task, { ...fastDeps, assertOwnership: async () => {
    checks += 1;
    if (checks === 3) throw new Error("stop after staging");
  } })).rejects.toThrow("stop after staging");
  const [generation] = await db.select().from(schema.htmlScanGenerations).where(eq(schema.htmlScanGenerations.taskId, task.id));
  const [page] = await db.select().from(schema.htmlScanPages).where(and(eq(schema.htmlScanPages.generationId, generation!.id), eq(schema.htmlScanPages.pageIndex, 20)));
  expect(page).toBeDefined();
  await db.update(schema.htmlScanPages).set({ postings: page!.postings.map(posting => ({ ...posting, descriptionText: "Older staged description" })) })
    .where(and(eq(schema.htmlScanPages.generationId, generation!.id), eq(schema.htmlScanPages.pageIndex, 20)));

  const newerFetchedAt = new Date("2026-09-06T06:00:00Z");
  const [job] = await db.insert(schema.jobs).values({ companyId: company.id, sourceId: source.id,
    externalKey: "url:https://pager.example/jobs/role-21", title: "Operations Role 21",
    normalizedTitle: "operations role 21", url: "https://pager.example/jobs/role-21",
    lastSeenAt: new Date("2026-09-04T06:00:00Z"),
    descriptionText: "Newer fetched description", descriptionSource: "direct",
    descriptionHash: sha1("Newer fetched description"), descriptionFetchedAt: newerFetchedAt }).returning();
  clock = new Date("2026-09-07T06:00:00Z");
  await handleScanCompany(task, fastDeps);
  const [after] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job!.id));
  expect(after!.descriptionText).toBe("Newer fetched description");
  expect(after!.descriptionHash).toBe(sha1("Newer fetched description"));
  expect(after!.descriptionFetchedAt).toEqual(newerFetchedAt);
}, 60_000);

it("treats an old-worker page timestamp as the generation start and cannot undo a later complete scan", async () => {
  const { company, source, task, fastDeps, fetchText } = await fixture();
  expect(await handleScanCompany(task, fastDeps)).toBeInstanceOf(TaskDeferred);
  const [generation] = await db.select().from(schema.htmlScanGenerations).where(eq(schema.htmlScanGenerations.taskId, task.id));
  expect(generation).toMatchObject({ publishedPageCount: 20 });

  // Simulate an older worker that appended a page without the new observed_at field and crashed
  // before its publication commit. The database default deliberately marks its time unknown.
  const oldPage = listing(20);
  await db.insert(schema.htmlScanPages).values({ generationId: generation!.id, pageIndex: 20,
    url: "https://pager.example/listing?page=20", nextUrl: null,
    contentHash: sha1(oldPage), semanticHash: sha1(oldPage), roleSetHash: sha1("role-21"),
    postings: [{ title: "Operations Role 21", url: "https://pager.example/jobs/role-21" }],
    bytesStored: 100 });
  await db.update(schema.htmlScanGenerations).set({ nextUrl: "", bytesStored: generation!.bytesStored + 100 })
    .where(eq(schema.htmlScanGenerations.id, generation!.id));
  const [staged] = await db.select().from(schema.htmlScanPages).where(and(eq(schema.htmlScanPages.generationId, generation!.id), eq(schema.htmlScanPages.pageIndex, 20)));
  expect(staged!.observedAt).toEqual(new Date("1970-01-01T00:00:00Z"));

  // A newer task completes an independent scan after the old generation started.
  clock = new Date("2026-09-06T06:00:00Z");
  const newerId = await enqueueTask(db, "scan_company", { companyId: company.id, trigger: "manual" }, { dedupeKey: null });
  const [newerTask] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, newerId!));
  fetchText.mockImplementation(async (requestUrl: string) => {
    const body = `<html><body><main><a href="/jobs/role-21">New Operations Director</a></main></body></html>`;
    return { url: requestUrl, status: 200, headers: {}, body, contentHash: sha1(body) };
  });
  await handleScanCompany(newerTask!, fastDeps);
  const [newerRole] = await db.select().from(schema.jobs).where(eq(schema.jobs.url, "https://pager.example/jobs/role-21"));
  expect(newerRole!.title).toBe("New Operations Director");

  fetchText.mockImplementation(async (requestUrl: string) => {
    const page = Number(new URL(requestUrl).searchParams.get("page") ?? "0");
    const body = listing(page);
    return { url: requestUrl, status: 200, headers: {}, body, contentHash: sha1(body) };
  });
  await handleScanCompany(task, fastDeps);
  const [role] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, newerRole!.id));
  expect(role).toMatchObject({ title: "New Operations Director", status: "open", missingScans: 0 });
  expect(role!.lastSeenAt).toEqual(newerRole!.lastSeenAt);
  expect((await db.select().from(schema.scans).where(eq(schema.scans.sourceId, source.id))).some(scan => scan.taskId === task.id && scan.closedCount > 0)).toBe(false);
}, 60_000);

it("rolls back positive writes and the publication cursor when ownership stops mid-commit", async () => {
  const { source, task, fastDeps } = await fixture();
  expect(await handleScanCompany(task, fastDeps)).toBeInstanceOf(TaskDeferred);
  const [generation] = await db.select().from(schema.htmlScanGenerations).where(eq(schema.htmlScanGenerations.taskId, task.id));
  expect(generation).toMatchObject({ publishedPageCount: 20 });

  // Model a crash after staging but before publication, then let a fresh claim try the interval.
  await db.delete(schema.jobs);
  await db.update(schema.htmlScanGenerations).set({ publishedPageCount: 0, publishedNewCount: 0 })
    .where(eq(schema.htmlScanGenerations.id, generation!.id));
  const controller = new AbortController();
  let release!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const blocker = db.transaction(async tx => {
    await tx.execute(sql`lock table jobs in share mode`);
    locked();
    await gate;
  });
  await ready;
  const resumed = handleScanCompany(task, { ...fastDeps, signal: controller.signal });
  try {
    let inserting = false;
    for (let n = 0; n < 200 && !inserting; n++) {
      const result = await db.execute<{ inserting: boolean }>(sql`select exists(select 1 from pg_stat_activity
        where pid <> pg_backend_pid() and datname = current_database() and wait_event_type = 'Lock'
          and query like 'insert into "jobs"%') as inserting`);
      inserting = result.rows[0]?.inserting === true;
      if (!inserting) await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(inserting).toBe(true);
    controller.abort(new Error("test ownership lost"));
  } finally {
    release();
  }
  await blocker;
  await expect(resumed).rejects.toThrow("test ownership lost");
  expect(await db.select().from(schema.jobs)).toHaveLength(0);
  expect(await db.select().from(schema.userJobs)).toHaveLength(0);
  expect(await db.select().from(schema.scans).where(eq(schema.scans.sourceId, source.id))).toHaveLength(0);
  const [after] = await db.select().from(schema.htmlScanGenerations).where(eq(schema.htmlScanGenerations.id, generation!.id));
  expect(after).toMatchObject({ publishedPageCount: 0, publishedNewCount: 0 });
  expect(await db.select().from(schema.htmlScanPages).where(eq(schema.htmlScanPages.generationId, generation!.id))).toHaveLength(21);

  // A rolling old worker could have staged that last page without observed_at. Its default is
  // unknown, so the resumed worker must use the generation start as the conservative sighting.
  await db.update(schema.htmlScanPages).set({ observedAt: new Date("1970-01-01T00:00:00Z") })
    .where(and(eq(schema.htmlScanPages.generationId, generation!.id), eq(schema.htmlScanPages.pageIndex, 20)));
  expect(await handleScanCompany(task, fastDeps)).toBeInstanceOf(TaskDeferred);
  const [drained] = await db.select().from(schema.htmlScanGenerations).where(eq(schema.htmlScanGenerations.id, generation!.id));
  expect(drained).toMatchObject({ publishedPageCount: 20, publishedNewCount: 20 });
  expect(await db.select().from(schema.jobs)).toHaveLength(20);
  expect(await db.select().from(schema.scans).where(eq(schema.scans.sourceId, source.id))).toHaveLength(0);
  await handleScanCompany(task, fastDeps);
  const [recovered] = await db.select().from(schema.jobs).where(eq(schema.jobs.url, "https://pager.example/jobs/role-21"));
  expect(recovered!.lastSeenAt).toEqual(generation!.startedAt);
  expect(await db.select().from(schema.jobs)).toHaveLength(21);
  const [scan] = await db.select().from(schema.scans).where(eq(schema.scans.sourceId, source.id));
  expect(scan).toMatchObject({ status: "ok", newCount: 21, closedCount: 0 });
  await handleScanCompany(task, fastDeps);
  expect(await db.select().from(schema.scans).where(eq(schema.scans.sourceId, source.id))).toHaveLength(1);
}, 60_000);
