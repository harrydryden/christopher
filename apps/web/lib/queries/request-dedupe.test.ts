/**
 * Reads that several parts of one render ask for are issued once per request. React's request
 * memo stands in for `cache` here, which outside a server render memoises nothing; each test is
 * one "request" because the memo is cleared between them. Per-account reads stay keyed by account.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
const reads = vi.hoisted(() => ({ n: 0, memos: [] as Array<Map<string, unknown>> }));
vi.mock("@/lib/db", () => ({ db: () => { reads.n++; return database; } }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const cache = <A extends unknown[], R>(fn: (...args: A) => R) => {
    const memo = new Map<string, R>();
    reads.memos.push(memo as Map<string, unknown>);
    return (...args: A): R => {
      const key = JSON.stringify(args);
      if (!memo.has(key)) memo.set(key, fn(...args));
      return memo.get(key)!;
    };
  };
  return { ...actual, cache };
});
import { getSettingsFor, getSystemSettings } from "@/lib/settings";
import { suggestionCount } from "./suggestions";
import { getLatestDiscoveryRun } from "./companies";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());
beforeEach(async () => {
  await database.execute(sql`truncate settings, user_settings, company_suggestions, companies, users restart identity cascade`);
  for (const memo of reads.memos) memo.clear();
  reads.n = 0;
});

it("reads the system settings once and each account's settings once per request", async () => {
  const user = await ensureTestUser(database, "dedupe@example.com");
  const other = await ensureTestUser(database, "dedupe-other@example.com");
  await database.insert(schema.settings).values({ key: "scanTime", value: "07:30" });
  await database.insert(schema.userSettings).values({ userId: user.id, key: "seedProfile", value: "A designer" });
  reads.n = 0;

  // The strip's system settings, the page's settings and a CV quote's settings.
  expect((await getSystemSettings()).scanTime).toBe("07:30");
  const [first, second] = await Promise.all([getSettingsFor(user.id), getSettingsFor(user.id)]);
  expect(first.scanTime).toBe("07:30");
  expect(second).toEqual(first);
  expect(reads.n).toBe(2);
  // Another account's rows are their own read, and never this account's.
  const theirs = await getSettingsFor(other.id);
  expect(reads.n).toBe(3);
  expect(theirs.scanTime).toBe("07:30");
  expect(first.seedProfile).toBe("A designer");
  expect(theirs.seedProfile).toBe("");
});

it("reads afresh through a caller's own writer, which may just have written", async () => {
  const user = await ensureTestUser(database, "dedupe-writer@example.com");
  expect((await getSettingsFor(user.id)).scanTime).not.toBe("09:15");
  await database.insert(schema.settings).values({ key: "scanTime", value: "09:15" });
  expect((await getSettingsFor(user.id, database)).scanTime).toBe("09:15");
});

it("counts pending company suggestions once per request, per account and per question", async () => {
  const user = await ensureTestUser(database, "dedupe-suggest@example.com");
  const other = await ensureTestUser(database, "dedupe-suggest-other@example.com");
  await database.insert(schema.companySuggestions).values([
    { userId: user.id, name: "One", domain: "one.test", homepageUrl: "https://one.test", rank: 0 },
    { userId: other.id, name: "Two", domain: "two.test", homepageUrl: "https://two.test", rank: 0 },
    { userId: other.id, name: "Three", domain: "three.test", homepageUrl: "https://three.test", rank: 1 },
  ]);
  reads.n = 0;
  expect(await suggestionCount(user.id)).toBe(1);
  expect(await suggestionCount(user.id, false, "")).toBe(1);
  expect(reads.n).toBe(1);
  expect(await suggestionCount(user.id, true)).toBe(0);
  expect(await suggestionCount(other.id)).toBe(2);
  expect(reads.n).toBe(3);
});

it("reads a company's latest discovery run once per request", async () => {
  const [company] = await database.insert(schema.companies).values({ name: "Acme", domain: "acme.test", homepageUrl: "https://acme.test" }).returning();
  await database.insert(schema.discoveryRuns).values({ companyId: company!.id, status: "resolved" });
  reads.n = 0;
  const [a, b] = await Promise.all([getLatestDiscoveryRun(company!.id), getLatestDiscoveryRun(company!.id)]);
  expect(a?.status).toBe("resolved");
  expect(b).toBe(a);
  expect(reads.n).toBe(1);
});
