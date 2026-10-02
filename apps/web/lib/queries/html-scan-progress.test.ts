import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { ensureTestUser } from "@/test/auth";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
vi.mock("@/lib/db", () => ({ db: () => database }));
import { listHtmlScanProgress } from "./html-scan-progress";
import { countHealthItems, healthItemDetail, healthItems } from "./health";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());
beforeEach(async () => {
  await database.execute(sql`truncate companies, tasks, users restart identity cascade`);
});

it("shows only an active follower's latest unfinished source generation and its staged page counts", async () => {
  const mine = await ensureTestUser(database, "continuation-mine@example.com");
  const other = await ensureTestUser(database, "continuation-other@example.com");
  const [company, hidden] = await database.insert(schema.companies).values([
    { name: "Mine", domain: "continuation-mine.example", homepageUrl: "https://continuation-mine.example" },
    { name: "Hidden", domain: "continuation-hidden.example", homepageUrl: "https://continuation-hidden.example" },
  ]).returning();
  await database.insert(schema.companySubscriptions).values([
    { userId: mine.id, companyId: company!.id, status: "active" },
    { userId: other.id, companyId: hidden!.id, status: "active" },
  ]);
  const [source, hiddenSource] = await database.insert(schema.careerSources).values([
    { companyId: company!.id, type: "html", url: "https://continuation-mine.example/jobs" },
    { companyId: hidden!.id, type: "html", url: "https://continuation-hidden.example/jobs" },
  ]).returning();
  const at = new Date(Date.now() - 10 * 60_000);
  const later = new Date(Date.now() + 5 * 60_000);
  const [task, otherTask] = await database.insert(schema.tasks).values([
    { type: "scan_company", payload: { companyId: company!.id }, status: "queued", createdAt: at, runAfter: later },
    { type: "scan_company", payload: { companyId: hidden!.id }, status: "queued", createdAt: at, runAfter: later },
  ]).returning();
  const [generation, otherGeneration] = await database.insert(schema.htmlScanGenerations).values([
    { taskId: task!.id, sourceId: source!.id, sourceFingerprint: "one", nextUrl: "https://continuation-mine.example/jobs?page=3", startedAt: at, expiresAt: later, publishedPageCount: 1, publishedNewCount: 8 },
    { taskId: otherTask!.id, sourceId: hiddenSource!.id, sourceFingerprint: "two", nextUrl: "", startedAt: at, expiresAt: later },
  ]).returning();
  await database.insert(schema.htmlScanPages).values([
    { generationId: generation!.id, pageIndex: 0, url: source!.url, nextUrl: "?page=2", contentHash: "a", semanticHash: "a", roleSetHash: "a", postings: [{ id: 1 }, { id: 2 }], bytesStored: 20 },
    { generationId: generation!.id, pageIndex: 1, url: `${source!.url}?page=2`, nextUrl: "?page=3", contentHash: "b", semanticHash: "b", roleSetHash: "b", postings: [{ id: 3 }], bytesStored: 10 },
    { generationId: otherGeneration!.id, pageIndex: 0, url: hiddenSource!.url, nextUrl: null, contentHash: "c", semanticHash: "c", roleSetHash: "c", postings: [{ id: 4 }], bytesStored: 10 },
  ]);

  expect(await listHtmlScanProgress(mine.id)).toMatchObject([{ companyName: "Mine", sourceUrl: source!.url, pagesRead: 2, publishedPages: 1, stagedPostings: 3, taskStatus: "queued" }]);
  expect((await listHtmlScanProgress(other.id)).map(row => [row.companyName, row.publishedPages])).toEqual([["Hidden", 0]]);

  // A new queued scan supersedes the abandoned one even before the new read has a page.
  const [retry] = await database.insert(schema.tasks).values({ type: "scan_company", payload: { companyId: company!.id }, status: "queued", createdAt: new Date(at.getTime() + 1000), runAfter: later }).returning();
  expect(await listHtmlScanProgress(mine.id)).toEqual([]);
  const [newGeneration] = await database.insert(schema.htmlScanGenerations).values({
    taskId: retry!.id, sourceId: source!.id, sourceFingerprint: "one", nextUrl: source!.url,
    startedAt: new Date(at.getTime() + 1000), expiresAt: later,
  }).returning();
  expect((await listHtmlScanProgress(mine.id)).map(row => [row.generationId, row.pagesRead, row.publishedPages])).toEqual([[newGeneration!.id, 0, 0]]);

  // A later complete observation is the resolution, even if its old checkpoint awaits cleanup.
  await database.insert(schema.scans).values({ sourceId: source!.id, status: "ok", startedAt: later, finishedAt: later });
  expect(await listHtmlScanProgress(mine.id)).toEqual([]);
  await database.update(schema.companySubscriptions).set({ status: "paused" }).where(eq(schema.companySubscriptions.userId, other.id));
  expect(await listHtmlScanProgress(other.id)).toEqual([]);
});

it("counts an interrupted read as one actionable company issue without duplicating a partial scan", async () => {
  const user = await ensureTestUser(database, "continuation-action@example.com");
  const [company] = await database.insert(schema.companies).values({
    name: "Interrupted", domain: "continuation-interrupted.example", homepageUrl: "https://continuation-interrupted.example",
  }).returning();
  await database.insert(schema.companySubscriptions).values({ userId: user.id, companyId: company!.id, status: "active" });
  const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://continuation-interrupted.example/jobs" }).returning();
  const startedAt = new Date(Date.now() - 10 * 60_000);
  const [task] = await database.insert(schema.tasks).values({
    type: "scan_company", payload: { companyId: company!.id }, status: "failed", createdAt: startedAt, error: "Network stopped",
  }).returning();
  await database.insert(schema.htmlScanGenerations).values({
    taskId: task!.id, sourceId: source!.id, sourceFingerprint: "interrupted", nextUrl: "?page=2",
    startedAt, expiresAt: new Date(Date.now() + 60_000), publishedPageCount: 1,
  });

  expect(await listHtmlScanProgress(user.id)).toMatchObject([{ taskStatus: "failed", publishedPages: 1 }]);
  expect(await countHealthItems(user.id)).toBe(1);
  const published = await healthItems(user.id);
  expect(published.map(item => item.kind)).toEqual(["incomplete_read"]);
  expect(healthItemDetail(published[0]!)).toBe("This listing check did not finish. Any matching roles already found remain available. Open the company and choose Rescan once monitoring is running.");
  await database.update(schema.htmlScanGenerations).set({ publishedPageCount: 0 });
  expect(healthItemDetail((await healthItems(user.id))[0]!)).toBe(healthItemDetail(published[0]!));

  await database.insert(schema.scans).values({ sourceId: source!.id, status: "partial", startedAt: new Date(startedAt.getTime() + 1000) });
  expect(await countHealthItems(user.id)).toBe(1);
  expect((await healthItems(user.id)).map(item => item.kind)).toEqual(["partial"]);

  await database.update(schema.companies).set({ status: "paused" }).where(eq(schema.companies.id, company!.id));
  expect(await listHtmlScanProgress(user.id)).toEqual([]);
});
