/**
 * The roles page's reads, as the page makes them. The counts are one read per request however many
 * parts ask; a page's count and rows travel together; and a link that names its view does not wait
 * for the counts before reading the page. React's request memo stands in for `cache` here, which
 * outside a server render memoises nothing.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, subscribeToCompany, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const cache = <A extends unknown[], R>(fn: (...args: A) => R) => {
    const memo = new Map<string, R>();
    return (...args: A): R => {
      const key = JSON.stringify(args);
      if (!memo.has(key)) memo.set(key, fn(...args));
      return memo.get(key)!;
    };
  };
  return { ...actual, cache };
});
import { fetchRoleCounts, fetchRolePage, parseRolesFilters } from "./jobs";
import { RoleWorkspace } from "@/components/RoleWorkspace";

let user: User;
let companyId: string;

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());
beforeEach(async () => {
  await database.execute(sql`truncate users, companies restart identity cascade`);
  user = await ensureTestUser(database, `role-page-${crypto.randomUUID()}@example.com`);
  const [company] = await database.insert(schema.companies).values({ name: "Acme", domain: "acme.test", homepageUrl: "https://acme.test" }).returning();
  companyId = company!.id;
  await subscribeToCompany(database, user.id, companyId);
  const [source] = await database.insert(schema.careerSources).values({ companyId, type: "html", url: "https://acme.test/jobs" }).returning();
  const rows = await database.insert(schema.jobs).values(Array.from({ length: 60 }, (_, i) => ({
    companyId, sourceId: source!.id, externalKey: `id:${i}`, title: `Role ${String(i).padStart(2, "0")}`, normalizedTitle: `role ${i}`, url: `https://acme.test/jobs/${i}`,
  }))).returning();
  await database.insert(schema.userJobs).values(rows.map((job) => ({ userId: user.id, jobId: job.id, keywordMatched: true, locationOk: true, inTable: true })));
});

/** Statements sent while `read` runs, and the most that were in flight at once. */
async function measured<T>(read: () => Promise<T>) {
  let inFlight = 0;
  let widest = 0;
  const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
  const spy = vi.spyOn(pool, "query").mockImplementation(((...args: unknown[]) => {
    inFlight++;
    widest = Math.max(widest, inFlight);
    return query(...args).finally(() => { inFlight--; });
  }) as never);
  try {
    const value = await read();
    return { value, count: spy.mock.calls.length, widest };
  } finally {
    spy.mockRestore();
  }
}

it("counts the whole table once per request, however many parts ask", async () => {
  const { value, count } = await measured(async () => [await fetchRoleCounts(user.id), await fetchRoleCounts(user.id, undefined), await fetchRoleCounts(user.id, "")]);
  expect(count).toBe(1);
  expect(value[0]!["auto-matched"]).toBe(60);
  expect(value[1]).toBe(value[0]);
  // A company's counts are their own reading.
  expect((await measured(() => fetchRoleCounts(user.id, companyId))).count).toBe(1);
});

it("reads a page's count and rows together, and the last page for a link past the end", async () => {
  const filters = parseRolesFilters({ sort: "title", dir: "asc" });
  const second = await measured(() => fetchRolePage(user.id, filters, false, null, 2));
  expect(second).toMatchObject({ count: 2, widest: 2 });
  expect(second.value).toMatchObject({ total: 60, page: 2, pageCount: 2 });
  expect(second.value.visible.map((row) => row.job.title)).toEqual(Array.from({ length: 10 }, (_, i) => `Role ${50 + i}`));

  const past = await measured(() => fetchRolePage(user.id, filters, false, null, 9));
  expect(past.count).toBe(3);
  expect(past.value.page).toBe(2);
  expect(past.value.visible.map((row) => row.job.id)).toEqual(second.value.visible.map((row) => row.job.id));
});

it("reads the counts beside the page when the link names its view", async () => {
  const { value, widest } = await measured(() => RoleWorkspace({ userId: user.id, searchParams: { view: "auto-matched", sort: "title" } }));
  expect(value).toBeTruthy();
  // The counts, the page's count and rows, the company list and the stage counts, all at once.
  expect(widest).toBeGreaterThanOrEqual(5);
});
