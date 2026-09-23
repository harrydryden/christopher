import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Task } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { articleLinks, handleMonitorSource, handleExtractDocument, handleVerifyCompany, quoteSupportsCandidate } from "./handlers/external-sources";
import { verifyCandidate } from "./handlers/companies";
import { claimTask, completeTask } from "./queue";
import { schedulerTick } from "./scheduler";
import { ensureTestUser } from "./test-users";
vi.mock("./handlers/companies", () => ({ verifyCandidate: vi.fn(async () => ({ homepageOk: true, careersSource: { type: "greenhouse", url: "https://boards.greenhouse.io/acme", confidence: 0.95 }, openRoles: 4, matchingRoles: 1 })) }));
const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test");
let deps: WorkerDeps;
let userId: string;
const now = new Date("2026-09-11T00:00:00Z");
const content = "Acme Robotics raised funding to expand its London operations team. ".repeat(3);
beforeAll(async () => {
  await runMigrations(client.db);
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";
  process.env.AVA_DISABLE_BROWSER = "1";
  deps = await createDeps(readEnv(), { now: () => now, settingsTtlMs: 0 });
});
afterAll(async () => { if (deps) await client.db.execute(sql`truncate discovery_sources cascade`); await deps?.close(); await client.pool.end(); });
beforeEach(async () => {
  vi.restoreAllMocks();
  await client.db.execute(sql`truncate discovery_sources, company_suggestions, companies, tasks, settings, scan_runs, ai_calls restart identity cascade`);
  userId = (await ensureTestUser(client.db, "sources@example.com")).id;
  Object.defineProperty(deps.ai, "enabled", { value: true, configurable: true });
});
async function sourceWithDocument() {
  const [source] = await client.db.insert(schema.discoverySources).values({ userId, name: "Scaling Europe", kind: "email", nextRunAt: now }).returning();
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
    { userId, name: "Paused", kind: "email", enabled: false, nextRunAt: now },
    { userId, name: "Future", kind: "email", nextRunAt: new Date("2026-10-01") },
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
  const [source] = await client.db.insert(schema.discoverySources).values({ userId, name: "Empty inbox", kind: "email", nextRunAt: now }).returning();
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

it("anchors an extracted candidate's name and homepage in its own quote", () => {
  expect(quoteSupportsCandidate("Acme Robotics raised funding", "Acme", "https://acme.example")).toBe(true);
  expect(quoteSupportsCandidate("Hims & Hers expands in London", "Hims and Hers", "https://www.hims.com/")).toBe(true);
  expect(quoteSupportsCandidate("Read more at monzo.com about the round", "Monzo Bank", "https://monzo.com")).toBe(false);
  expect(quoteSupportsCandidate("Monzo Bank opened an office; see monzo.com", "Monzo Bank", "https://monzo.com")).toBe(true);
  // The model's formal name, and a homepage tied to the passage through the company's name.
  expect(quoteSupportsCandidate("Acme Robotics raised funding", "Acme Robotics Ltd", "https://acmerobotics.example")).toBe(true);
  expect(quoteSupportsCandidate("Acme Robotics raised funding", "Acme Robotics", "https://acme.example")).toBe(true);
  // A genuine sentence carrying an injected company, or an injected homepage beside a real name.
  expect(quoteSupportsCandidate("Acme Robotics raised funding", "Evil Corp", "https://evil.example")).toBe(false);
  expect(quoteSupportsCandidate("Acme Robotics raised funding", "Acme", "https://evil.example")).toBe(false);
});

it("drops an extracted candidate whose quote is about someone else", async () => {
  const source = await sourceWithDocument();
  vi.spyOn(deps.ai, "extractSourceCompanies").mockResolvedValue({ candidates: [
    { name: "Evil Corp", homepageUrl: "https://evil.example", rationale: "Fits", quote: "Acme Robotics raised funding", recommended: true },
  ] });
  await handleMonitorSource(task(source.id), deps); await runStages();
  expect(await client.db.select().from(schema.discoveryCandidates)).toHaveLength(0);
  expect(await client.db.select().from(schema.companySuggestions)).toHaveLength(0);
});

async function pendingCandidate() {
  const source = await sourceWithDocument();
  const [document] = await client.db.select().from(schema.discoveryDocuments);
  const [candidate] = await client.db.insert(schema.discoveryCandidates).values({ userId, documentId: document!.id, name: "Acme", domain: "acme.example",
    homepageUrl: "https://acme.example", rationale: "Fits", quote: "Acme Robotics raised funding" }).returning();
  return { source, candidate: candidate! };
}

it("records a permanent verification failure as final instead of retrying it for ever", async () => {
  const { source, candidate } = await pendingCandidate();
  vi.mocked(verifyCandidate).mockResolvedValueOnce({ homepageOk: false, error: "HTTP 404" });
  const outcome = await handleVerifyCompany({ payload: { sourceId: source.id, candidateId: candidate.id } } as unknown as Task, deps);
  expect(outcome).toEqual({ stored: 0, rejected: "HTTP 404" });
  const [processed] = await client.db.select().from(schema.discoveryCandidates);
  expect(processed!.processedAt).not.toBeNull();
  expect(await client.db.select().from(schema.companySuggestions)).toHaveLength(0);
});

it("retries a verification that failed only for now", async () => {
  const { source, candidate } = await pendingCandidate();
  vi.mocked(verifyCandidate).mockResolvedValueOnce({ homepageOk: false, error: "rate limited (429)", transient: true });
  await expect(handleVerifyCompany({ payload: { sourceId: source.id, candidateId: candidate.id } } as unknown as Task, deps)).rejects.toThrow("rate limited");
  const [pending] = await client.db.select().from(schema.discoveryCandidates);
  expect(pending!.processedAt).toBeNull();
});
