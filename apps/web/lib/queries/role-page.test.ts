/**
 * The roles page's reads, as the page makes them. The counts are one read per request however many
 * parts ask; a page's count and rows travel together; and a link that names its view does not wait
 * for the counts before reading the page. React's request memo stands in for `cache` here, which
 * outside a server render memoises nothing.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, subscribeToCompany, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, inArray, sql } from "drizzle-orm";
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
import { fetchRoleCounts, fetchRolePage, fetchRoleRows, parseRolesFilters } from "./jobs";
import { RoleWorkspace } from "@/components/RoleWorkspace";

let user: User;
let companyId: string;

beforeAll(async () => {
  const client = createTestDb();
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

/** The first element under `node` whose props match, depth first. */
function findElement(node: unknown, match: (props: Record<string, unknown>) => boolean): { key: string | null; props: Record<string, unknown> } | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) { const found = findElement(child, match); if (found) return found; }
    return null;
  }
  const element = node as { key?: string | null; props?: Record<string, unknown> };
  if (element.props && match(element.props)) return { key: element.key ?? null, props: element.props };
  return element.props ? findElement(element.props.children, match) : null;
}

/** Statements in the order they started and finished, labelled for the two asserted on. */
async function sequenced<T>(read: () => Promise<T>) {
  const events: string[] = [];
  const label = (text: string) => text.includes("json_build_array(") ? "rows" : /^select case\s+when/.test(text) && text.includes("group by") ? "counts" : "other";
  const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
  const spy = vi.spyOn(pool, "query").mockImplementation(((...args: unknown[]) => {
    const first = args[0] as string | { text: string };
    const name = label(typeof first === "string" ? first : first.text);
    events.push(`start ${name}`);
    return query(...args).finally(() => { events.push(`end ${name}`); });
  }) as never);
  try {
    return { value: await read(), events };
  } finally {
    spy.mockRestore();
  }
}

it("reads the landing URL's Matched page beside the counts instead of after them", async () => {
  const { value, events } = await sequenced(() => RoleWorkspace({ userId: user.id, searchParams: {} }));
  expect(events.indexOf("start rows")).toBeGreaterThanOrEqual(0);
  expect(events.indexOf("start rows")).toBeLessThan(events.indexOf("end counts"));
  // One page read: the guess was right.
  expect(events.filter((event) => event === "start rows")).toHaveLength(1);
  expect(findElement(value, (props) => props["aria-current"] === "page")?.key).toBe("auto-matched");
});

it("opens on Shortlisted when nothing is matched, reading that page once the counts say so", async () => {
  const rows = await database.select({ id: schema.jobs.id, title: schema.jobs.title }).from(schema.jobs);
  await database.insert(schema.decisions).values(rows.map((job, i) => ({ userId: user.id, jobId: job.id, decision: i < 3 ? "apply" as const : "skip" as const, jobTitle: job.title, companyName: "Acme" })));
  const { value, events } = await sequenced(() => RoleWorkspace({ userId: user.id, searchParams: {} }));
  expect(events.filter((event) => event === "start rows")).toHaveLength(2);
  expect(findElement(value, (props) => props["aria-current"] === "page")?.key).toBe("user-shortlisted");
  const table = findElement(value, (props) => Array.isArray(props.rows) && "keyboard" in props);
  expect((table?.props.rows as unknown[]).length).toBe(3);
});

it("counts exactly the roles the page read admits, for every kind of filter", async () => {
  const rows = await database.select({ id: schema.jobs.id, title: schema.jobs.title }).from(schema.jobs).orderBy(schema.jobs.externalKey);
  await database.insert(schema.decisions).values(rows.slice(0, 5).map((job) => ({ userId: user.id, jobId: job.id, decision: "apply" as const, jobTitle: job.title, companyName: "Acme" })));
  // A superseded decision is not the active one, and must not double a row in the count.
  await database.insert(schema.decisions).values({ userId: user.id, jobId: rows[0]!.id, decision: "skip", jobTitle: rows[0]!.title, companyName: "Acme", superseded: true });
  await database.update(schema.userJobs).set({ fitScore: 80 }).where(inArray(schema.userJobs.jobId, rows.slice(0, 20).map((job) => job.id)));
  await database.update(schema.userJobs).set({ archivedAt: new Date() }).where(eq(schema.userJobs.jobId, rows[59]!.id));
  const views: Array<[Record<string, string>, boolean]> = [
    [{ view: "auto-matched" }, false],
    [{ view: "user-shortlisted" }, false],
    [{ view: "auto-matched", company: companyId }, false],
    [{ view: "auto-matched", company: crypto.randomUUID() }, false],
    [{ view: "auto-matched", minFit: "50", q: "role 1" }, false],
    [{ view: "archived" }, true],
  ];
  for (const [params, archived] of views) {
    const filters = parseRolesFilters(params);
    const { total } = await fetchRolePage(user.id, filters, archived, null, 1);
    expect(total, JSON.stringify(params)).toBe((await fetchRoleRows(user.id, filters, archived, { limit: 1000 })).length);
  }
  expect((await fetchRolePage(user.id, parseRolesFilters({ view: "user-shortlisted" }), false, null, 1)).total).toBe(5);
});
