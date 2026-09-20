/**
 * The setup checklist is derived, not remembered: every step is a fact about rows that exist for
 * one account. These are those reads, and the rule that keeps the first scan behind chosen filters.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { eq, sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";
import { buildSetupChecklist } from "@/lib/setup";
import type { User } from "@christopher/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
let other: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { hasChosenGate, requireChosenGate, setupStatus } from "./setup";

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
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
  entries: entries.map((entry, index) => ({ id: `e${index}`, status: "active" as const, details: "Did the work", ...entry })),
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
  });
  const checklist = buildSetupChecklist(facts);
  expect(checklist.summary).toBe("0 of 5 done");
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

  await followCompany(user.id, "one.example");
  await followCompany(user.id, "two.example");
  // An archived subscription is not a company this account follows; another account's is not either.
  await followCompany(user.id, "three.example", "archived");
  await followCompany(other.id, "four.example");
  expect(await setupStatus(user.id)).toMatchObject({ companiesFollowed: 2, libraryFilled: false });
  expect(buildSetupChecklist(await setupStatus(user.id)).steps[3]).toMatchObject({ done: false, progress: "2 of 3" });

  await followCompany(user.id, "five.example", "paused");
  expect(await setupStatus(user.id)).toMatchObject({ companiesFollowed: 3 });

  // A Library with no experience in it is not a filled Library.
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library([{ kind: "skill", heading: "Tools" }]) });
  expect(await setupStatus(user.id)).toMatchObject({ libraryFilled: false });
  // The latest version decides, so adding a job finishes the step.
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 2, content: library([{ kind: "skill", heading: "Tools" }, { kind: "experience", heading: "Director · Acme" }]) });
  expect(await setupStatus(user.id)).toMatchObject({ libraryFilled: true });

  const checklist = buildSetupChecklist(await setupStatus(user.id));
  expect(checklist.complete).toBe(true);
  expect(checklist.summary).toBe("5 of 5 done");
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
