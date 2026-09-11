import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { eq, sql } from "drizzle-orm";
import { discoverySourceState } from "@/lib/discovery-ux";
let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
const auth = vi.hoisted(() => ({ requireSession: vi.fn(async () => {}) }));
vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { saveDiscoverySource, updateDiscoverySource, checkDiscoverySource, importDiscoveryDocument } from "./discovery-sources";
import { acceptSuggestion, rejectSuggestion, findMoreSuggestions } from "./suggestions";
function form(values: Record<string, string>) { const data = new FormData(); for (const [key, value] of Object.entries(values)) data.set(key, value); return data; }
beforeAll(async () => { const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test"); database = client.db; pool = client.pool; await runMigrations(database); });
afterAll(async () => { if (database) await database.execute(sql`truncate discovery_sources cascade`); await pool?.end(); });
beforeEach(async () => { auth.requireSession.mockReset(); await database.execute(sql`truncate discovery_sources, company_suggestions, companies, tasks, settings restart identity cascade`); });
async function source() {
  const [row] = await database.insert(schema.discoverySources).values({ name: "Weekly newsletter", kind: "email", nextRunAt: new Date("2030-01-01") }).returning(); return row!;
}
async function recommendation() {
  const [row] = await database.insert(schema.companySuggestions).values({ name: "Acme", domain: "acme.example", homepageUrl: "https://acme.example", verification: { homepageOk: true, careersSource: { type: "greenhouse", url: "https://boards.greenhouse.io/acme", confidence: 0.95 } } }).returning(); return row!;
}
it("gives useful input errors and prevents equivalent sources across concurrent submissions", async () => {
  expect((await saveDiscoverySource(form({ name: "Weekly", kind: "website", intervalDays: "7" }))).ok).toBe(false);
  const outcomes = await Promise.all(["https://news.example/blog/", "https://news.example/blog?utm_source=email"].map(url => saveDiscoverySource(form({ name: "Weekly", kind: "website", intervalDays: "7", url }))));
  expect(outcomes.filter(r => r.ok)).toHaveLength(1);
  expect(await database.select().from(schema.discoverySources)).toHaveLength(1);
});
it("recognises canonical duplicates of previously saved sources", async () => {
  await database.insert(schema.discoverySources).values({ name: "Old source", kind: "website", url: "https://news.example/blog/" });
  expect((await saveDiscoverySource(form({ name: "New", kind: "website", intervalDays: "7", url: "https://news.example/blog" }))).ok).toBe(false);
});
it("preserves a due date on an unchanged save and makes a resumed source due now", async () => {
  const row = await source();
  expect((await updateDiscoverySource(row.id, form({ enabled: "on", intervalDays: "7", name: "Renamed newsletter" }))).ok).toBe(true);
  let [updated] = await database.select().from(schema.discoverySources);
  expect(updated!.nextRunAt.toISOString()).toBe("2030-01-01T00:00:00.000Z"); expect(updated!.name).toBe("Renamed newsletter");
  await updateDiscoverySource(row.id, form({ intervalDays: "7" }));
  expect((await checkDiscoverySource(row.id)).ok).toBe(false);
  await updateDiscoverySource(row.id, form({ enabled: "on", intervalDays: "7" }));
  [updated] = await database.select().from(schema.discoverySources);
  expect(updated!.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now());
});
it("reports duplicate imports without silently truncating long editions", async () => {
  const row = await source(); const data = form({ title: "Edition", content: "Acme expands its London team. ".repeat(10) });
  expect((await importDiscoveryDocument(row.id, data)).ok).toBe(true);
  expect(await importDiscoveryDocument(row.id, data)).toMatchObject({ ok: true, message: expect.stringContaining("already imported") });
  expect((await importDiscoveryDocument(row.id, form({ title: "Long", content: "x".repeat(40001) }))).ok).toBe(false);
  expect(await database.select().from(schema.discoveryDocuments)).toHaveLength(1);
});
it("blocks checks when discovery is disabled, on both discovery paths", async () => {
  const row = await source(); await database.insert(schema.settings).values({ key: "suggestionsEnabled", value: false });
  expect((await checkDiscoverySource(row.id)).ok).toBe(false); expect((await findMoreSuggestions()).ok).toBe(false);
  expect(await database.select().from(schema.tasks)).toHaveLength(0);
});
it("queues a single check and distinguishes repeated requests", async () => {
  const row = await source();
  expect(await checkDiscoverySource(row.id)).toMatchObject({ ok: true, message: expect.stringContaining("Check queued") });
  expect(await checkDiscoverySource(row.id)).toMatchObject({ ok: true, message: expect.stringContaining("already") });
  expect(await database.select().from(schema.tasks)).toHaveLength(1);
});
it("makes accepting a recommendation atomic and safe to repeat", async () => {
  const row = await recommendation();
  const results = await Promise.all([acceptSuggestion(row.id), acceptSuggestion(row.id)]);
  expect(results.filter(r => r.ok)).toHaveLength(1);
  expect(await database.select().from(schema.companies)).toHaveLength(1);
  const queued = await database.select().from(schema.tasks);
  expect(queued).toHaveLength(2); expect(queued.find(t => t.type === "discover")!.payload).toMatchObject({ url: "https://boards.greenhouse.io/acme" });
  expect(await database.select().from(schema.careerSources)).toHaveLength(0);
  expect((await rejectSuggestion(row.id, form({ reason: "Changed my mind" }))).ok).toBe(false);
  expect((await database.select().from(schema.companySuggestions))[0]!.status).toBe("accepted");
});
it("resolves a company already added elsewhere without duplicate setup", async () => {
  const row = await recommendation(); await database.insert(schema.companies).values({ name: "Acme", domain: row.domain, homepageUrl: row.homepageUrl });
  expect((await acceptSuggestion(row.id)).ok).toBe(true);
  expect(await database.select().from(schema.companies)).toHaveLength(1); expect(await database.select().from(schema.tasks)).toHaveLength(0);
});
it("requires a reason and retains a dismissal once reviewed", async () => {
  const row = await recommendation();
  expect((await rejectSuggestion(row.id, form({ reason: " " }))).ok).toBe(false);
  expect((await rejectSuggestion(row.id, form({ reason: "Wrong industry" }))).ok).toBe(true);
  expect((await acceptSuggestion(row.id)).ok).toBe(false);
});
it("authenticates before attempting a mutation", async () => {
  auth.requireSession.mockRejectedValueOnce(new Error("Unauthorised"));
  await expect(saveDiscoverySource(form({}))).rejects.toThrow("Unauthorised");
});
it("distinguishes paused, disabled, active and empty-email states", () => {
  const base = { enabled: true, suggestionsEnabled: true, lastError: null, waiting: 0, lastCheckedAt: null, kind: "email" };
  expect(discoverySourceState(base)).toBe("Waiting for content");
  expect(discoverySourceState({ ...base, activeStatus: "queued" })).toBe("Queued");
  expect(discoverySourceState({ ...base, enabled: false, activeStatus: "queued" })).toBe("Paused");
  expect(discoverySourceState({ ...base, suggestionsEnabled: false })).toBe("Discovery disabled");
});
it("rolls back acceptance if queuing careers setup fails", async () => {
  const row = await recommendation();
  const queue = await import("@/lib/enqueue");
  const failure = vi.spyOn(queue, "enqueue").mockRejectedValueOnce(new Error("Queue unavailable"));
  try {
    await expect(acceptSuggestion(row.id)).rejects.toThrow("Queue unavailable");
    expect(await database.select().from(schema.companies)).toHaveLength(0);
    expect((await database.select().from(schema.companySuggestions))[0]!.status).toBe("pending");
  } finally { failure.mockRestore(); }
});
