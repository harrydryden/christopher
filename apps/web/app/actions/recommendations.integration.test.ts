import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { sql, eq } from "drizzle-orm";
import { schema, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { recommendCatalogueRoles } from "@col/db/catalogue-recommendations";
import type { CareerRecommendationProfile } from "@col/core/catalogue-recommendations";
import type { GateSettings } from "@col/core";
import { createTestDb } from "@/test/db";
import { ensureTestUser } from "@/test/auth";

let database: Db;
let client: ReturnType<typeof createTestDb>;
let user: typeof schema.users.$inferSelect;
const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { decideCatalogueRecommendation } from "./recommendations";

const profile: CareerRecommendationProfile = { version: 1, hash: "mine", roles: ["Operations Director"], skills: ["Lean Six Sigma"], industries: [], terms: [] };
const gate: GateSettings = { includeKeywords: ["operations"], excludeKeywords: [], matchFields: ["title"], locationTerms: ["UK"], includeRemote: true };
beforeAll(async () => { client = createTestDb(); database = client.db; await runMigrations(database); });
afterAll(async () => { await client?.pool.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate users, companies, tasks, settings restart identity cascade`);
  user = await ensureTestUser(database, "recommendation@example.test", "member");
  auth.requireUser.mockReset(); auth.requireUser.mockResolvedValue(user);
});
async function role(patch: Partial<typeof schema.jobs.$inferInsert> = {}) {
  const [company] = await database.insert(schema.companies).values({ name: "Catalogue employer", domain: `${crypto.randomUUID()}.test`, homepageUrl: "https://employer.test" }).returning();
  const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://employer.test/jobs" }).returning();
  const manual = patch.manualOwnerId ? { origin: "manual" as const, sourceId: null, shared: false, manualFingerprint: crypto.randomUUID(), companyLabel: "Private employer", inputKind: "link" as const } : {};
  const [job] = await database.insert(schema.jobs).values({ companyId: company!.id, sourceId: source!.id, externalKey: crypto.randomUUID(), title: "Operations Lead", normalizedTitle: "operations lead", descriptionText: "Lean Six Sigma", location: "London", url: "https://employer.test/jobs/1", ...manual, ...patch }).returning();
  return job!;
}
it("discovers shared catalogue roles with zero follows, excludes private/stale/closed postings and never creates account views on read", async () => {
  const valid = await role();
  await role({ shared: false }); await role({ manualOwnerId: user.id }); await role({ status: "closed" }); await role({ lastSeenAt: new Date("2020-01-01") });
  await role({ location: "New York", remote: true });
  expect((await recommendCatalogueRoles(database, user.id, profile, gate)).map(item => item.role.id)).toEqual([valid.id]);
  expect(await database.select().from(schema.companySubscriptions)).toEqual([]);
  expect(await database.select().from(schema.userJobs)).toEqual([]);
  expect(await database.select().from(schema.tasks)).toEqual([]);
});
it("honours account-owned company/role dismissals without applying another user's choices", async () => {
  const companyDismissed = await role(); const hidden = await role(); const decided = await role(); const otherOnly = await role();
  const other = await ensureTestUser(database, "other-recommendation@example.test", "member");
  const companies = await database.select().from(schema.companies).where(eq(schema.companies.id, companyDismissed.companyId!));
  await database.insert(schema.companySuggestions).values({ userId: user.id, name: "Dismissed", domain: companies[0]!.domain, homepageUrl: "https://employer.test", status: "rejected" });
  await database.insert(schema.userJobs).values([{ userId: user.id, jobId: hidden.id, hidden: true }, { userId: other.id, jobId: otherOnly.id, hidden: true }]);
  await database.insert(schema.decisions).values({ userId: user.id, jobId: decided.id, decision: "skip", jobTitle: decided.title, companyName: "Employer" });
  expect((await recommendCatalogueRoles(database, user.id, profile, gate)).map(item => item.role.id)).toEqual([otherOnly.id]);
});
it("continues retrieval past an off-location first page instead of hiding an eligible role", async () => {
  const valid = await role({ lastSeenAt: new Date(Date.now() - 10_000) });
  await database.insert(schema.jobs).values(Array.from({ length: 500 }, (_, index) => ({
    companyId: valid.companyId, sourceId: valid.sourceId, externalKey: `abroad-${index}`, title: valid.title,
    normalizedTitle: valid.normalizedTitle, descriptionText: valid.descriptionText, location: "New York", url: `https://employer.test/jobs/abroad-${index}`,
  })));
  expect((await recommendCatalogueRoles(database, user.id, profile, gate)).map(item => item.role.id)).toEqual([valid.id]);
});
it("shortlists once from the catalogue without following, billing or model work, and never overwrites a later choice", async () => {
  const job = await role();
  const replies = await Promise.all([decideCatalogueRecommendation(job.id, "apply"), decideCatalogueRecommendation(job.id, "apply")]);
  expect(replies).toEqual([{ ok: true }, { ok: true }]);
  expect(await database.select().from(schema.decisions)).toHaveLength(1);
  expect(await database.select().from(schema.userJobs)).toHaveLength(1);
  expect(await database.select().from(schema.companySubscriptions)).toHaveLength(0);
  expect(await database.select().from(schema.tasks)).toHaveLength(0);
  expect(await decideCatalogueRecommendation(job.id, "skip")).toMatchObject({ ok: false, error: expect.stringContaining("already reviewed") });
});
it("rechecks availability, preferences and recommendations opt-out when a rendered choice is submitted", async () => {
  const privateJob = await role({ shared: false });
  expect((await decideCatalogueRecommendation(privateJob.id, "apply")).ok).toBe(false);
  const stale = await role({ lastSeenAt: new Date("2020-01-01") });
  expect((await decideCatalogueRecommendation(stale.id, "apply")).ok).toBe(false);
  const abroad = await role({ location: "New York" });
  await database.insert(schema.userSettings).values({ userId: user.id, key: "gate", value: gate });
  expect((await decideCatalogueRecommendation(abroad.id, "apply")).ok).toBe(false);
  const valid = await role();
  await database.insert(schema.userSettings).values({ userId: user.id, key: "suggestionsEnabled", value: false });
  expect((await decideCatalogueRecommendation(valid.id, "apply")).ok).toBe(false);
  expect(await database.select().from(schema.userJobs)).toHaveLength(0);
});
it("dismisses a recommendation once, keeps the decision private and excludes it next time", async () => {
  const job = await role();
  expect(await decideCatalogueRecommendation(job.id, "skip")).toEqual({ ok: true });
  expect(await recommendCatalogueRoles(database, user.id, profile, gate)).toEqual([]);
  const other = await ensureTestUser(database, "still-visible@example.test", "member");
  expect((await recommendCatalogueRoles(database, other.id, profile, gate)).map(item => item.role.id)).toEqual([job.id]);
});
it("does not let an old card override a newly dismissed company", async () => {
  const job = await role();
  const [company] = await database.select().from(schema.companies).where(eq(schema.companies.id, job.companyId!));
  await database.insert(schema.companySuggestions).values({ userId: user.id, name: company!.name, domain: company!.domain, homepageUrl: company!.homepageUrl, status: "rejected" });
  expect(await decideCatalogueRecommendation(job.id, "apply")).toMatchObject({ ok: false, error: expect.stringContaining("dismissed this company") });
  expect(await database.select().from(schema.userJobs)).toHaveLength(0);
});
it("authenticates before reading or writing any candidate", async () => {
  auth.requireUser.mockRejectedValueOnce(new Error("sign in"));
  await expect(decideCatalogueRecommendation(crypto.randomUUID(), "apply")).rejects.toThrow("sign in");
  expect(await database.select().from(schema.userJobs)).toHaveLength(0);
});
