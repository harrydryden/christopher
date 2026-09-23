import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import type { User } from "@ava/db/schema";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";
import { discoverySourceState } from "@/lib/discovery-ux";
import { ensureTestUser } from "@/test/auth";
let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
const auth = vi.hoisted(() => ({ requireUser: vi.fn(), requireSession: vi.fn(), requireVerifiedUser: vi.fn() }));
vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { saveDiscoverySource, updateDiscoverySource, checkDiscoverySource, importDiscoveryDocument } from "./discovery-sources";
import { acceptSuggestion, rejectSuggestion, findMoreSuggestions } from "./suggestions";
function form(values: Record<string, string>) { const data = new FormData(); for (const [key, value] of Object.entries(values)) data.set(key, value); return data; }
beforeAll(async () => { const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test"); database = client.db; pool = client.pool; await runMigrations(database); user = await ensureTestUser(database); });
afterAll(async () => { if (database) await database.execute(sql`truncate discovery_sources cascade`); await pool?.end(); });
beforeEach(async () => {
  auth.requireUser.mockReset(); auth.requireUser.mockImplementation(async () => user);
  auth.requireSession.mockReset(); auth.requireSession.mockImplementation(async () => user);
  auth.requireVerifiedUser.mockReset(); auth.requireVerifiedUser.mockImplementation(async () => auth.requireUser());
  await database.execute(sql`truncate discovery_sources, company_suggestions, companies, tasks, settings, user_settings restart identity cascade`);
  // Filters first: following a recommended company waits on a gate this account chose.
  await database.insert(schema.userSettings).values({ userId: user.id, key: "gate", value: { includeKeywords: ["operations"], excludeKeywords: [], matchFields: ["title"], locationTerms: [], includeRemote: true } });
});
async function source() {
  const [row] = await database.insert(schema.discoverySources).values({ userId: user.id, name: "Weekly newsletter", kind: "email", nextRunAt: new Date("2030-01-01") }).returning(); return row!;
}
async function recommendation() {
  const [row] = await database.insert(schema.companySuggestions).values({ userId: user.id, name: "Acme", domain: "acme.example", homepageUrl: "https://acme.example", verification: { homepageOk: true, careersSource: { type: "greenhouse", url: "https://boards.greenhouse.io/acme", confidence: 0.95 } } }).returning(); return row!;
}
it("gives useful input errors and prevents equivalent sources across concurrent submissions", async () => {
  expect((await saveDiscoverySource(form({ name: "Weekly", kind: "website", intervalDays: "7" }))).ok).toBe(false);
  const outcomes = await Promise.all(["https://news.example/blog/", "https://news.example/blog?utm_source=email"].map(url => saveDiscoverySource(form({ name: "Weekly", kind: "website", intervalDays: "7", url }))));
  expect(outcomes.filter(r => r.ok)).toHaveLength(1);
  expect(await database.select().from(schema.discoverySources)).toHaveLength(1);
});
it("recognises canonical duplicates of previously saved sources, per account", async () => {
  await database.insert(schema.discoverySources).values({ userId: user.id, name: "Old source", kind: "website", url: "https://news.example/blog/" });
  expect((await saveDiscoverySource(form({ name: "New", kind: "website", intervalDays: "7", url: "https://news.example/blog" }))).ok).toBe(false);
  // Another account may follow the same newsletter; sources are private.
  const other = await ensureTestUser(database, "other@example.com", "member");
  auth.requireUser.mockImplementation(async () => other);
  expect((await saveDiscoverySource(form({ name: "Mine", kind: "website", intervalDays: "7", url: "https://news.example/blog" }))).ok).toBe(true);
  expect(await database.select().from(schema.discoverySources)).toHaveLength(2);
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
it("refuses to touch another account's source", async () => {
  const row = await source();
  const other = await ensureTestUser(database, "other@example.com", "member");
  auth.requireUser.mockImplementation(async () => other);
  expect((await updateDiscoverySource(row.id, form({ enabled: "on", intervalDays: "3", name: "Hijacked" }))).ok).toBe(false);
  expect((await checkDiscoverySource(row.id)).ok).toBe(false);
  expect((await importDiscoveryDocument(row.id, form({ title: "Edition", content: "Acme expands its London team. ".repeat(10) }))).ok).toBe(false);
  expect((await database.select().from(schema.discoverySources))[0]!.name).toBe("Weekly newsletter");
  expect(await database.select().from(schema.discoveryDocuments)).toHaveLength(0);
});
it("blocks checks when discovery is disabled for the account, on both discovery paths", async () => {
  const row = await source(); await database.insert(schema.userSettings).values({ userId: user.id, key: "suggestionsEnabled", value: false });
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
  expect(await database.select().from(schema.companySubscriptions)).toMatchObject([{ userId: user.id, status: "active" }]);
  const queued = await database.select().from(schema.tasks);
  expect(queued).toHaveLength(2); expect(queued.find(t => t.type === "discover")!.payload).toMatchObject({ url: "https://boards.greenhouse.io/acme" });
  expect(await database.select().from(schema.careerSources)).toHaveLength(0);
  expect((await rejectSuggestion(row.id, form({ reason: "Changed my mind" }))).ok).toBe(false);
  expect((await database.select().from(schema.companySuggestions))[0]!.status).toBe("accepted");
});
it("follows a company already in the shared catalogue without repeating its setup", async () => {
  const row = await recommendation();
  const [company] = await database.insert(schema.companies).values({ name: "Acme", domain: row.domain, homepageUrl: row.homepageUrl }).returning();
  await database.insert(schema.careerSources).values({ companyId: company!.id, type: "greenhouse", url: "https://boards.greenhouse.io/acme", status: "active" });
  expect(await acceptSuggestion(row.id)).toMatchObject({ ok: true, message: expect.stringContaining("shared catalogue") });
  expect(await database.select().from(schema.companies)).toHaveLength(1); expect(await database.select().from(schema.tasks)).toHaveLength(0);
  expect(await database.select().from(schema.companySubscriptions)).toMatchObject([{ userId: user.id, companyId: company!.id }]);
});
it("re-discovers a catalogue company that has no usable careers source when it is followed", async () => {
  const row = await recommendation();
  await database.insert(schema.companies).values({ name: "Acme", domain: row.domain, homepageUrl: row.homepageUrl });
  expect((await acceptSuggestion(row.id)).ok).toBe(true);
  const queued = await database.select().from(schema.tasks);
  expect(queued.map(t => t.type)).toEqual(["discover"]);
});
it("requires a reason and retains a dismissal once reviewed", async () => {
  const row = await recommendation();
  expect((await rejectSuggestion(row.id, form({ reason: " " }))).ok).toBe(false);
  expect((await rejectSuggestion(row.id, form({ reason: "Wrong industry" }))).ok).toBe(true);
  expect((await acceptSuggestion(row.id)).ok).toBe(false);
});
it("authenticates before attempting a mutation", async () => {
  auth.requireUser.mockRejectedValueOnce(new Error("Unauthorised"));
  await expect(saveDiscoverySource(form({}))).rejects.toThrow("Unauthorised");
  auth.requireVerifiedUser.mockRejectedValueOnce(new Error("Confirm your email"));
  await expect(checkDiscoverySource((await source()).id)).rejects.toThrow("Confirm your email");
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
    expect(await database.select().from(schema.companySubscriptions)).toHaveLength(0);
    expect((await database.select().from(schema.companySuggestions))[0]!.status).toBe("pending");
  } finally { failure.mockRestore(); }
});
it("holds a member who already follows 200 companies to that when accepting a recommendation", async () => {
  const member = await ensureTestUser(database, "full@example.com", "member");
  auth.requireUser.mockImplementation(async () => member);
  await database.insert(schema.userSettings).values({ userId: member.id, key: "gate", value: { includeKeywords: ["operations"], excludeKeywords: [], matchFields: ["title"], locationTerms: [], includeRemote: true } });
  const held = await database.insert(schema.companies).values(Array.from({ length: 200 }, (_, n) => ({ name: `Held ${n}`, domain: `held${n}.example`, homepageUrl: `https://held${n}.example` }))).returning({ id: schema.companies.id });
  await database.insert(schema.companySubscriptions).values(held.map(row => ({ userId: member.id, companyId: row.id })));
  const [row] = await database.insert(schema.companySuggestions).values({ userId: member.id, name: "Acme", domain: "acme.example", homepageUrl: "https://acme.example" }).returning();
  expect(await acceptSuggestion(row!.id)).toEqual({ ok: false, error: expect.stringContaining("up to 200 companies") });
  expect(await database.select().from(schema.companies).where(eq(schema.companies.domain, "acme.example"))).toHaveLength(0);
  expect((await database.select().from(schema.companySuggestions))[0]!.status).toBe("pending");
});
it("refuses a discovery source on an address the worker will never fetch", async () => {
  expect(await saveDiscoverySource(form({ name: "Intranet", kind: "website", intervalDays: "7", url: "http://127.0.0.1/news" })))
    .toEqual({ ok: false, error: "127.0.0.1 is a private or local network address." });
  expect(await database.select().from(schema.discoverySources)).toHaveLength(0);
  const [row] = await database.insert(schema.discoverySources).values({ userId: user.id, name: "Blog", kind: "website", url: "https://news.example/blog" }).returning();
  expect(await updateDiscoverySource(row!.id, form({ intervalDays: "7", url: "http://wiki.internal/jobs" })))
    .toEqual({ ok: false, error: "wiki.internal is a local network name." });
  expect((await database.select().from(schema.discoverySources))[0]!.url).toBe("https://news.example/blog");
});
it("keeps an account to 20 discovery sources", async () => {
  await database.insert(schema.discoverySources).values(Array.from({ length: 20 }, (_, n) => ({ userId: user.id, name: `Source ${n}`, kind: "website" as const, url: `https://news${n}.example/` })));
  expect(await saveDiscoverySource(form({ name: "One more", kind: "website", intervalDays: "7", url: "https://more.example/blog" })))
    .toEqual({ ok: false, error: "You can keep up to 20 sources, and this list is full. Point one you no longer read at the new address instead." });
  expect(await database.select().from(schema.discoverySources)).toHaveLength(20);
});
