/**
 * The setup checklist is derived, not remembered: every step is a fact about rows that exist for
 * one account. These are those reads, and the rule that keeps the first scan behind chosen filters.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@col/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@col/db/migrate";
import { eq, sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";
import { buildSetupChecklist } from "@/lib/setup";
import type { User } from "@col/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
let other: User;
const reads = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/db", () => ({ db: () => { reads.n++; return database; } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { hasChosenGate, requireChosenGate, setupStatus } from "./setup";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  await database.execute(sql`truncate companies, cv_libraries, settings, users restart identity cascade`);
  user = await ensureTestUser(database, "setup@example.com", "member");
  other = await ensureTestUser(database, "someone-else@example.com", "member");
  // A member who has not confirmed yet: the account a new sign-up actually starts from.
  await database.update(schema.users).set({ emailVerifiedAt: null }).where(eq(schema.users.id, user.id));
});

const setting = (userId: string, key: string, value: unknown) =>
  database.insert(schema.userSettings).values({ userId, key, value: value as object });

async function followCompany(userId: string, domain: string, status: "active" | "paused" | "archived" = "active") {
  const [company] = await database.insert(schema.companies).values({ name: domain, homepageUrl: `https://${domain}`, domain }).returning();
  await database.insert(schema.companySubscriptions).values({ userId, companyId: company!.id, status });
  return company!;
}

const library = (entries: Array<{ kind: "experience" | "education" | "skill"; heading: string }>) => ({
  name: "Test Candidate",
  contact: "London",
  profile: "",
  entries: entries.map((entry, index) => ({ id: `e${index}`, status: "active" as const, details: "Did the work", confirmedResponsibilities: ["Owned delivery"], ...entry })),
});

it("reports a fresh account as nothing done at all", async () => {
  const facts = await setupStatus(user.id);
  expect(facts).toEqual({
    emailConfirmed: false,
    gateChosen: false,
    seedProfileWritten: false,
    companiesFollowed: 0,
    libraryFilled: false,
    dismissedAt: null,
    monitoring: { activeCompanies: 0, successfulCompanies: 0, attentionCompanies: 0, pendingCompanies: 0, lastSuccessAt: null },
  });
  const checklist = buildSetupChecklist(facts);
  expect(checklist.summary).toBe("0 of 4 done");
  expect(checklist.nextStep?.id).toBe("email");
});

it("flips each step as its own fact changes, and counts nobody else's rows", async () => {
  await database.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, user.id));
  expect(await setupStatus(user.id)).toMatchObject({ emailConfirmed: true, gateChosen: false });

  await setting(user.id, "gate", { includeKeywords: ["operations"], excludeKeywords: [], matchFields: ["title"], locationTerms: ["London"], includeRemote: true });
  expect(await setupStatus(user.id)).toMatchObject({ gateChosen: true, seedProfileWritten: false });

  // Whitespace is not a seed profile.
  await setting(user.id, "seedProfile", "   ");
  expect(await setupStatus(user.id)).toMatchObject({ seedProfileWritten: false });
  await database.update(schema.userSettings).set({ value: "Operations leadership in London." })
    .where(eq(schema.userSettings.key, "seedProfile"));
  expect(await setupStatus(user.id)).toMatchObject({ seedProfileWritten: true });

  const first = await followCompany(user.id, "one.example");
  await followCompany(user.id, "two.example");
  // An archived subscription is not a company this account follows; another account's is not either.
  await followCompany(user.id, "three.example", "archived");
  await followCompany(other.id, "four.example");
  expect(await setupStatus(user.id)).toMatchObject({ companiesFollowed: 2, libraryFilled: false });
  expect(buildSetupChecklist(await setupStatus(user.id)).steps[2]).toMatchObject({ done: true, progress: "2 following" });

  await followCompany(user.id, "five.example", "paused");
  expect(await setupStatus(user.id)).toMatchObject({ companiesFollowed: 3 });

  // A Library with no experience in it is not a filled Library.
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library([{ kind: "skill", heading: "Tools" }]) });
  expect(await setupStatus(user.id)).toMatchObject({ libraryFilled: false });
  // The latest version decides, so adding a job finishes the step.
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 2, content: library([{ kind: "skill", heading: "Tools" }, { kind: "experience", heading: "Director · Acme" }]) });
  expect(await setupStatus(user.id)).toMatchObject({ libraryFilled: true });

  expect(buildSetupChecklist(await setupStatus(user.id)).complete).toBe(false);
  await database.insert(schema.careerSources).values({ companyId: first.id, type: "html", url: "https://one.example/jobs", lastOkScanAt: new Date("2026-09-29T08:00:00Z") });
  const checklist = buildSetupChecklist(await setupStatus(user.id));
  expect(checklist.complete).toBe(true);
  expect(checklist.summary).toBe("4 of 4 done");
  expect(checklist.nextStep).toBeNull();

  // Every fact belongs to one account: the other one has done none of it.
  expect(await setupStatus(other.id)).toMatchObject({ gateChosen: false, seedProfileWritten: false, companiesFollowed: 1, libraryFilled: false });
});

it("reads the dismissal marker as the account's own", async () => {
  expect((await setupStatus(user.id)).dismissedAt).toBeNull();
  await setting(user.id, "setupDismissedAt", "2026-09-19T08:00:00.000Z");
  expect((await setupStatus(user.id)).dismissedAt).toBe("2026-09-19T08:00:00.000Z");
  expect(buildSetupChecklist(await setupStatus(user.id)).dismissed).toBe(true);
  expect((await setupStatus(other.id)).dismissedAt).toBeNull();
});

it("treats a chosen gate as an account's own row, never the administrator's", async () => {
  expect(await hasChosenGate(user.id)).toBe(false);
  await expect(requireChosenGate(user.id)).rejects.toThrow("Choose your keywords and locations first");

  // A stray user-scoped row in the shared table is not this account choosing its filters.
  await database.insert(schema.settings).values({ key: "gate", value: { includeKeywords: ["everything"] } });
  expect(await hasChosenGate(user.id)).toBe(false);
  expect((await setupStatus(user.id)).gateChosen).toBe(false);

  await setting(user.id, "gate", { includeKeywords: ["operations"] });
  expect(await hasChosenGate(user.id)).toBe(true);
  await expect(requireChosenGate(user.id)).resolves.toBeUndefined();
  // Still nobody else's.
  expect(await hasChosenGate(other.id)).toBe(false);
});

it("reads every fact in one statement, and only this account's", async () => {
  await setting(user.id, "gate", { keywords: ["operations"] });
  await setting(user.id, "seedProfile", "Operations lead");
  await setting(other.id, "setupDismissedAt", "2026-09-01T00:00:00.000Z");
  await followCompany(user.id, "one.example");
  await followCompany(other.id, "two.example");
  reads.n = 0;
  const facts = await setupStatus(user.id);
  expect(reads.n).toBe(1);
  expect(facts).toMatchObject({ gateChosen: true, seedProfileWritten: true, companiesFollowed: 1, dismissedAt: null });
  expect(await setupStatus(other.id)).toMatchObject({ gateChosen: false, companiesFollowed: 1, dismissedAt: "2026-09-01T00:00:00.000Z" });
});


it("distinguishes queued discovery, partial results and a complete empty scan without borrowing another account's success", async () => {
  await setting(user.id, "gate", { includeKeywords: ["operations"] });
  const company = await followCompany(user.id, "watch.example");
  const another = await followCompany(other.id, "other.example");
  await database.insert(schema.careerSources).values({ companyId: another.id, type: "html", url: "https://other.example/jobs", lastOkScanAt: new Date() });
  expect((await setupStatus(user.id)).monitoring).toMatchObject({ activeCompanies: 1, successfulCompanies: 0, attentionCompanies: 1, pendingCompanies: 0 });
  const [task] = await database.insert(schema.tasks).values({ type: "discover", payload: { companyId: company.id }, status: "queued" }).returning();
  const pending = await setupStatus(user.id);
  expect(pending.monitoring).toMatchObject({ attentionCompanies: 0, pendingCompanies: 1, workerState: "stopped" });
  expect(buildSetupChecklist(pending).notice).toMatchObject({ state: "monitoring-paused", href: "/health" });
  await database.update(schema.tasks).set({ status: "done" }).where(eq(schema.tasks.id, task!.id));
  const [source] = await database.insert(schema.careerSources).values({ companyId: company.id, type: "html", url: "https://watch.example/jobs" }).returning();
  await database.insert(schema.scans).values({ sourceId: source!.id, status: "partial", startedAt: new Date("2026-09-29T08:00:00Z"), finishedAt: new Date("2026-09-29T08:01:00Z") });
  expect((await setupStatus(user.id)).monitoring).toMatchObject({ attentionCompanies: 1, successfulCompanies: 0, pendingCompanies: 0 });
  await database.insert(schema.scans).values({ sourceId: source!.id, status: "ok", postingsFound: 0, startedAt: new Date("2026-09-29T09:00:00Z"), finishedAt: new Date("2026-09-29T09:01:00Z") });
  await database.update(schema.careerSources).set({ lastOkScanAt: new Date("2026-09-29T09:01:00Z") }).where(eq(schema.careerSources.id, source!.id));
  const facts = await setupStatus(user.id);
  expect(facts.monitoring).toMatchObject({ attentionCompanies: 0, successfulCompanies: 1 });
  expect(facts.monitoring.workerState).toBeUndefined();
  expect(buildSetupChecklist(facts).notice.state).toBe("complete");
  await database.insert(schema.tasks).values({ type: "scan_company", payload: { companyId: company.id }, status: "queued" });
  const queuedRescan = await setupStatus(user.id);
  expect(queuedRescan.monitoring.workerState).toBe("stopped");
  expect(buildSetupChecklist(queuedRescan).notice.state).toBe("monitoring-paused");
  expect(buildSetupChecklist(queuedRescan).steps[3]).toMatchObject({ done: true });
});

it("does not call inactive or unconfirmed experience usable Library evidence", async () => {
  const content = library([{ kind: "experience", heading: "Delivery" }]);
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: { ...content, entries: content.entries.map(e => ({ ...e, confirmedResponsibilities: [] })) } });
  expect((await setupStatus(user.id)).libraryFilled).toBe(false);
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 2, content: { ...content, entries: content.entries.map(e => ({ ...e, status: "inactive" })) } });
  expect((await setupStatus(user.id)).libraryFilled).toBe(false);
});
