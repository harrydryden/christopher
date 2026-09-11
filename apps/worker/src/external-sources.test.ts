import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Task } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { eq, sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { articleLinks, handleMonitorSource, handleExtractDocument, handleVerifyCompany } from "./handlers/external-sources";
import { claimTask, completeTask } from "./queue";
import { schedulerTick } from "./scheduler";
vi.mock("./handlers/companies", () => ({ verifyCandidate: vi.fn(async () => ({ homepageOk: true, careersSource: { type: "greenhouse", url: "https://boards.greenhouse.io/acme", confidence: 0.95 }, openRoles: 4, matchingRoles: 1 })) }));
const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
let deps: WorkerDeps;
const now = new Date("2026-09-11T00:00:00Z");
const content = "Acme Robotics raised funding to expand its London operations team. ".repeat(3);
beforeAll(async () => {
  await runMigrations(client.db);
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test";
  process.env.CHRISTOPHER_DISABLE_BROWSER = "1";
  deps = await createDeps(readEnv(), { now: () => now, settingsTtlMs: 0 });
});
afterAll(async () => { if (deps) await client.db.execute(sql`truncate discovery_sources cascade`); await deps?.close(); await client.pool.end(); });
beforeEach(async () => {
  vi.restoreAllMocks();
  await client.db.execute(sql`truncate discovery_sources, company_suggestions, companies, tasks, settings, scan_runs, ai_calls restart identity cascade`);
  Object.defineProperty(deps.ai, "enabled", { value: true, configurable: true });
});
async function sourceWithDocument() {
  const [source] = await client.db.insert(schema.discoverySources).values({ name: "Scaling Europe", kind: "email", nextRunAt: now }).returning();
  await client.db.insert(schema.discoveryDocuments).values({ sourceId: source!.id, title: "Weekly edition", content, fingerprint: "unique" });
  return source!;
}
async function runStages() {
  while (true) {
    const next = await claimTask(client.db, "source-test", "background");
    if (!next) break;
    if (next.type === "extract_document") await handleExtractDocument(next, deps);
    else if (next.type === "verify_company") await handleVerifyCompany(next, deps);
    await completeTask(client.db, next, {});
  }
}
function task(sourceId: string) { return { payload: { sourceId } } as unknown as Task; }
it("follows LinkedIn editions, excludes navigation and deduplicates tracking links", () => {
  expect(articleLinks('<a href="/pulse/edition?trk=a">Edition</a><a href="/pulse/edition?trk=b">Again</a><a href="/login">Login</a>', "https://www.linkedin.com/newsletters/example")).toEqual(["https://www.linkedin.com/pulse/edition"]);
});
it("queues due enabled sources only, once across repeated scheduler ticks", async () => {
  const source = await sourceWithDocument();
  await client.db.insert(schema.discoverySources).values([
    { name: "Paused", kind: "email", enabled: false, nextRunAt: now },
    { name: "Future", kind: "email", nextRunAt: new Date("2026-10-01") },
  ]);
  await schedulerTick(deps); await schedulerTick(deps);
  const tasks = await client.db.select().from(schema.tasks).where(eq(schema.tasks.type, "monitor_source"));
  expect(tasks).toHaveLength(1); expect(tasks[0]!.payload).toEqual({ sourceId: source.id });
});
it("stores verified recommendations with evidence, never adds a company, and does not reprocess", async () => {
  const source = await sourceWithDocument();
  const extract = vi.spyOn(deps.ai, "extractSourceCompanies").mockResolvedValue({ candidates: [
    { name: "Acme", homepageUrl: "https://acme.example", rationale: "London operations employer", quote: "Acme Robotics raised funding", recommended: true },
    { name: "Invented", homepageUrl: "https://invented.example", rationale: "Fits", quote: "Not in the source", recommended: true },
    { name: "Irrelevant", homepageUrl: "https://other.example", rationale: "Poor fit", quote: "Acme Robotics", recommended: false },
  ] });
  await handleMonitorSource(task(source.id), deps); await runStages();
  const suggestions = await client.db.select().from(schema.companySuggestions);
  expect(suggestions).toHaveLength(1);
  expect(suggestions[0]).toMatchObject({ status: "pending", evidence: { sourceName: "Scaling Europe", title: "Weekly edition", quote: "Acme Robotics raised funding" } });
  expect(await client.db.select().from(schema.companies)).toHaveLength(0);
  const [updated] = await client.db.select().from(schema.discoverySources);
  expect(updated!.nextRunAt.toISOString()).toBe("2026-09-18T00:00:00.000Z");
  await handleMonitorSource(task(source.id), deps); await runStages();
  expect(extract).toHaveBeenCalledTimes(1);
  await client.db.insert(schema.discoveryDocuments).values({ sourceId: source.id, title: "Another edition", content, fingerprint: "different" });
  await handleMonitorSource(task(source.id), deps); await runStages();
  expect(await client.db.select().from(schema.companySuggestions)).toHaveLength(1);
});
it("retains unread documents and exposes failures when AI is unavailable", async () => {
  const source = await sourceWithDocument();
  Object.defineProperty(deps.ai, "enabled", { value: false, configurable: true });
  await handleMonitorSource(task(source.id), deps);
  await expect(runStages()).rejects.toThrow("AI unavailable");
  const [document] = await client.db.select().from(schema.discoveryDocuments);
  expect(document!.processedAt).toBeNull();
  const [updated] = await client.db.select().from(schema.discoverySources);
  expect(updated!.lastError).toContain("AI unavailable");
});
it("still processes imported text when a LinkedIn fetch is blocked", async () => {
  const source = await sourceWithDocument();
  await client.db.update(schema.discoverySources).set({ kind: "linkedin", url: "https://www.linkedin.com/newsletters/example" }).where(eq(schema.discoverySources.id, source.id));
  vi.spyOn(deps.fetcher, "fetchText").mockRejectedValue(new Error("Blocked"));
  vi.spyOn(deps.ai, "extractSourceCompanies").mockResolvedValue({ candidates: [] });
  await handleMonitorSource(task(source.id), deps); await runStages();
  const [document] = await client.db.select().from(schema.discoveryDocuments);
  expect(document!.processedAt).not.toBeNull();
  const [updated] = await client.db.select().from(schema.discoverySources);
  expect(updated!.lastError).toContain("Blocked");
});

it("waits for email content without requiring AI or reporting an error", async () => {
  const [source] = await client.db.insert(schema.discoverySources).values({ name: "Empty inbox", kind: "email", nextRunAt: now }).returning();
  Object.defineProperty(deps.ai, "enabled", { value: false, configurable: true });
  expect(await handleMonitorSource(task(source!.id), deps)).toEqual({ documents: 0, stored: 0 });
  const [updated] = await client.db.select().from(schema.discoverySources);
  expect(updated!.lastError).toBeNull();
});

it("uses the saved interval if it changes while collection is running", async () => {
  const source = await sourceWithDocument();
  await client.db.update(schema.discoverySources).set({ kind: "website", url: "https://example.test/news" }).where(eq(schema.discoverySources.id, source.id));
  vi.spyOn(deps.fetcher, "fetchText").mockImplementation(async url => {
    await client.db.update(schema.discoverySources).set({ intervalDays: 3 }).where(eq(schema.discoverySources.id, source.id));
    return { status: 200, body: content, url, headers: {} };
  });
  await handleMonitorSource(task(source.id), deps);
  const [updated] = await client.db.select().from(schema.discoverySources);
  expect(updated!.nextRunAt.toISOString()).toBe("2026-09-14T00:00:00.000Z");
});

it("checkpoints extraction before verification and resumes paused candidates without calling the model again", async () => {
  const source = await sourceWithDocument();
  const extract = vi.spyOn(deps.ai, "extractSourceCompanies").mockResolvedValue({ candidates: [
    { name: "Acme", homepageUrl: "https://acme.example", rationale: "Fits", quote: "Acme Robotics", recommended: true },
  ] });
  await handleMonitorSource(task(source.id), deps);
  const extraction = (await claimTask(client.db, "test", "background"))!;
  await handleExtractDocument(extraction, deps);
  await completeTask(client.db, extraction, {});
  expect((await client.db.select().from(schema.discoveryDocuments))[0]!.processedAt).not.toBeNull();
  await client.db.update(schema.discoverySources).set({ enabled: false }).where(eq(schema.discoverySources.id, source.id));
  await runStages();
  expect(await client.db.select().from(schema.companySuggestions)).toHaveLength(0);
  await client.db.update(schema.discoverySources).set({ enabled: true }).where(eq(schema.discoverySources.id, source.id));
  await handleMonitorSource(task(source.id), deps); await runStages();
  expect(extract).toHaveBeenCalledTimes(1);
  expect(await client.db.select().from(schema.companySuggestions)).toHaveLength(1);
});
