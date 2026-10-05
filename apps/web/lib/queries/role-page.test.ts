/**
 * The roles page's reads, as the page makes them. The counts are one read per request however many
 * parts ask; a page's count and rows travel together; and a link that names its view does not wait
 * for the counts before reading the page. React's request memo stands in for `cache` here, which
 * outside a server render memoises nothing.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, subscribeToCompany, type Db } from "@col/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@col/db/migrate";
import { and, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { roleStatusSql } from "@col/db";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@col/db/schema";

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
import { countRoles, fetchRoleCounts, fetchRolePage, fetchRoleRows, parseRolesFilters, tabCountedBy, type RoleCursor } from "./jobs";
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
  // The tab counts are already in hand for the request: the rows asked for, then the last page.
  expect(past.count).toBe(2);
  expect(past.value.page).toBe(2);
  expect(past.value.visible.map((row) => row.job.id)).toEqual(second.value.visible.map((row) => row.job.id));
});

it("takes a whole tab's total from the tab counts, and counts a narrower view itself", async () => {
  const rows = await database.select({ id: schema.jobs.id, title: schema.jobs.title }).from(schema.jobs).orderBy(schema.jobs.externalKey);
  await database.insert(schema.decisions).values(rows.slice(0, 7).map((job, i) => ({ userId: user.id, jobId: job.id, decision: i < 4 ? "apply" as const : "skip" as const, jobTitle: job.title, companyName: "Acme" })));
  await database.update(schema.userJobs).set({ archivedAt: new Date() }).where(inArray(schema.userJobs.jobId, rows.slice(50, 53).map((job) => job.id)));
  await database.update(schema.userJobs).set({ inTable: false }).where(eq(schema.userJobs.jobId, rows[55]!.id));
  await database.update(schema.userJobs).set({ fitScore: 70 }).where(inArray(schema.userJobs.jobId, rows.slice(10, 20).map((job) => job.id)));
  const plain: Array<[Record<string, string | string[]>, boolean]> = [
    [{ view: "auto-matched" }, false],
    [{ view: "user-shortlisted", sort: "decided" }, false],
    [{ view: "user-dismissed", sort: "title", dir: "desc" }, false],
    [{ view: "archived" }, true],
    [{ view: "auto-matched", company: companyId }, false],
    [{ view: "auto-matched", status: ["new", "active", "closed"] }, false],
  ];
  for (const [params, archived] of plain) {
    const filters = parseRolesFilters(params);
    expect(tabCountedBy(filters, archived), JSON.stringify(params)).not.toBeNull();
    await fetchRoleCounts(user.id, filters.company || undefined);
    // The counts are in hand for the request, so the page is one statement: its rows.
    const { value, count } = await measured(() => fetchRolePage(user.id, filters, archived, null, 1));
    expect(count, JSON.stringify(params)).toBe(1);
    // And the tab's number is the one the view's own count would have given.
    expect(value.total, JSON.stringify(params)).toBe(await countRoles(user.id, filters, archived));
  }
  const narrower: Array<[Record<string, string | string[]>, boolean]> = [
    [{ view: "auto-matched", q: "role 1" }, false],
    [{ view: "auto-matched", minFit: "50" }, false],
    [{ view: "auto-matched", status: "new" }, false],
    [{ view: "auto-matched", location: "london" }, false],
    [{ view: "user-shortlisted", since: "7d" }, false],
    [{ decision: "all" }, false],
    [{ view: "auto-matched", showHidden: "1" }, false],
  ];
  for (const [params, archived] of narrower) {
    const filters = parseRolesFilters(params);
    expect(tabCountedBy(filters, archived), JSON.stringify(params)).toBeNull();
    const { value, count } = await measured(() => fetchRolePage(user.id, filters, archived, null, 1));
    expect(count, JSON.stringify(params)).toBe(2);
    expect(value.total, JSON.stringify(params)).toBe(await countRoles(user.id, filters, archived));
  }
  expect((await fetchRoleCounts(user.id))["auto-matched"]).toBe(60 - 7 - 3 - 1);
});

it("reads the counts beside the page when the link names its view", async () => {
  const { value, widest, count } = await measured(() => RoleWorkspace({ userId: user.id, searchParams: { view: "auto-matched", sort: "title" } }));
  expect(value).toBeTruthy();
  // The counts (which are also the page's count), the rows, the company list and the stage counts, all at once.
  expect(widest).toBeGreaterThanOrEqual(4);
  // A whole tab is not counted twice, and no events are read for the page: those four and nothing after.
  expect(count).toBe(widest);
  expect(count).toBe(4);
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
  // Views the gate no longer admits, one with a decision and one without: the decided one stays in
  // its tab, the undecided one is archived in all but name.
  await database.update(schema.userJobs).set({ inTable: false }).where(inArray(schema.userJobs.jobId, [rows[1]!.id, rows[40]!.id]));
  await database.update(schema.jobs).set({ status: "closed", closedAt: new Date() }).where(inArray(schema.jobs.id, rows.slice(30, 35).map((job) => job.id)));
  await database.update(schema.jobs).set({ firstSeenAt: new Date(Date.now() - 30 * 86400000), location: "London" }).where(inArray(schema.jobs.id, rows.slice(35, 50).map((job) => job.id)));
  const views: Array<[Record<string, string | string[]>, boolean]> = [
    [{ view: "auto-matched" }, false],
    [{ view: "user-shortlisted" }, false],
    [{ view: "user-dismissed" }, false],
    [{ view: "auto-matched", company: companyId }, false],
    [{ view: "auto-matched", company: crypto.randomUUID() }, false],
    [{ view: "auto-matched", minFit: "50", q: "role 1" }, false],
    [{ view: "auto-matched", status: "new" }, false],
    [{ view: "auto-matched", status: ["new", "active"] }, false],
    [{ view: "auto-matched", status: "new", closed: "1" }, false],
    [{ view: "auto-matched", status: "" }, false],
    [{ view: "auto-matched", location: "london", sort: "company" }, false],
    [{ decision: "all" }, false],
    [{ decision: "undecided", sort: "fit" }, false],
    [{ view: "user-shortlisted", since: "7d", sort: "decided" }, false],
    [{ view: "archived" }, true],
    [{ view: "archived", company: companyId, sort: "company" }, true],
    [{ view: "archived", status: "closed" }, true],
  ];
  for (const [params, archived] of views) {
    const filters = parseRolesFilters(params);
    const { total } = await fetchRolePage(user.id, filters, archived, null, 1);
    const admitted = (await fetchRoleRows(user.id, filters, archived, { limit: 1000 })).map((row) => row.job.id);
    expect(total, JSON.stringify(params)).toBe(admitted.length);
    // And both admit exactly the rows the view's own definition (the case expression) does.
    expect([...admitted].sort(), JSON.stringify(params)).toEqual((await legacyRoleIds(user.id, filters, archived, { limit: 1000 })).sort());
  }
  expect((await fetchRolePage(user.id, parseRolesFilters({ view: "user-shortlisted" }), false, null, 1)).total).toBe(5);
  // Shortlisted keeps its decided role the gate has let go; Matched and Archived split the undecided one.
  expect((await fetchRoleRows(user.id, parseRolesFilters({ view: "user-shortlisted" }), false)).map((row) => row.job.id)).toContain(rows[1]!.id);
  expect((await fetchRoleRows(user.id, parseRolesFilters({ view: "auto-matched" }), false, { limit: 100 })).map((row) => row.job.id)).not.toContain(rows[40]!.id);
  expect((await fetchRoleRows(user.id, parseRolesFilters({ view: "archived" }), true)).map((row) => row.job.id)).toContain(rows[40]!.id);
});

/**
 * The page read as it was before it picked its keys first: one statement over every admitted row,
 * with the view named through the `case` expression. Kept here, reduced to ids and the joins that
 * can change membership or order, as the reference the two-step read must match row for row.
 */
async function legacyRoleIds(userId: string, filters: ReturnType<typeof parseRolesFilters>, archived: boolean, { offset = 0, limit = 50, now = new Date() } = {}) {
  const { jobs, userJobs, companies, decisions } = schema;
  const liveStart = sql`case when ${jobs.postedAt} <= ${jobs.firstSeenAt} + interval '1 day' then ${jobs.postedAt} else ${jobs.firstSeenAt} end`;
  const status = sql`case when ${jobs.status} = 'closed' then 'closed' when ${liveStart} >= ${new Date(now.getTime() - 7 * 86400000)} then 'new' else 'active' end`;
  const statuses = filters.closed ? [...new Set([...filters.status, "closed"])] : filters.status;
  const cutoff = filters.sinceDays === null ? null : new Date(now.getTime() - filters.sinceDays * 86400000);
  const conditions = and(
    eq(userJobs.userId, userId),
    archived ? eq(roleStatusSql, "archived") : ne(roleStatusSql, "archived"),
    statuses.length ? inArray(status, statuses) : undefined,
    filters.company ? eq(jobs.companyId, filters.company) : undefined,
    filters.decision === "inbox" || filters.decision === "undecided" ? isNull(decisions.id) : filters.decision === "apply" || filters.decision === "skip" ? eq(decisions.decision, filters.decision) : undefined,
    filters.minFit !== null ? sql`${userJobs.fitScore} >= ${filters.minFit}` : undefined,
    filters.q ? sql`position(lower(${filters.q}) in lower(${jobs.title})) > 0` : undefined,
    filters.location ? sql`(position(lower(${filters.location}) in lower(coalesce(${jobs.location}, ''))) > 0 or exists (select 1 from jsonb_array_elements_text(${jobs.locations}) l where position(lower(${filters.location}) in lower(l)) > 0))` : undefined,
    cutoff ? sql`${decisions.createdAt} >= ${cutoff}` : undefined,
  );
  const sorts: Record<string, SQL> = {
    status: sql`case ${status} when 'new' then 0 when 'active' then 1 else 2 end`,
    fit: sql`${userJobs.fitScore}`, company: sql`${companies.name}`, firstSeen: sql`${jobs.firstSeenAt}`, title: sql`${jobs.title}`, location: sql`coalesce(${jobs.location}, '')`,
    decided: sql`${decisions.createdAt}`,
    liveFor: sql`greatest(0, floor(extract(epoch from (case when ${jobs.status} = 'closed' then coalesce(${jobs.closedAt}, ${now}) else ${now} end - (${liveStart}))) / 86400))`,
  };
  const dir = filters.dir === "desc" ? "desc" : "asc";
  const flip = dir === "asc" ? "desc" : "asc";
  const order = filters.sort === "status"
    ? [sql`${sorts.status} ${sql.raw(dir)} nulls ${sql.raw(dir === "asc" ? "last" : "first")}`, sql`${userJobs.fitScore} ${sql.raw(flip)} nulls ${sql.raw(dir === "asc" ? "last" : "first")}`,
       sql`${jobs.firstSeenAt} ${sql.raw(flip)} nulls ${sql.raw(flip === "asc" ? "last" : "first")}`, sql`${jobs.id} asc nulls last`]
    : [sql`${sorts[filters.sort]!} ${sql.raw(dir)} nulls last`, sql`${jobs.id} asc nulls last`];
  const read = await database.select({ id: jobs.id }).from(userJobs)
    .innerJoin(jobs, eq(jobs.id, userJobs.jobId))
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .leftJoin(decisions, and(eq(decisions.userId, userId), eq(decisions.jobId, jobs.id), eq(decisions.superseded, false)))
    .where(conditions).orderBy(...order).limit(limit).offset(offset);
  return read.map((row) => row.id);
}

it("reads page 2 of every order exactly as the single statement did", async () => {
  // 140 roles across two companies, with ties on every sort key but the id, nulls in fit, all three
  // freshness states, decisions and archives, so a page boundary falls inside groups of equals.
  const [other] = await database.insert(schema.companies).values({ name: "Beta", domain: "beta.test", homepageUrl: "https://beta.test" }).returning();
  await subscribeToCompany(database, user.id, other!.id);
  const [otherSource] = await database.insert(schema.careerSources).values({ companyId: other!.id, type: "html", url: "https://beta.test/jobs" }).returning();
  const extra = await database.insert(schema.jobs).values(Array.from({ length: 80 }, (_, i) => ({
    companyId: other!.id, sourceId: otherSource!.id, externalKey: `beta:${i}`, title: `Role ${String(i % 7).padStart(2, "0")}`, normalizedTitle: `role ${i}`,
    url: `https://beta.test/jobs/${i}`, location: i % 3 ? "London" : null,
    firstSeenAt: new Date(Date.UTC(2026, 8, 1 + (i % 20))), postedAt: i % 4 === 0 ? new Date(Date.UTC(2026, 8, 1 + (i % 20))) : null,
    status: i % 9 === 0 ? "closed" as const : "open" as const, closedAt: i % 9 === 0 ? new Date(Date.UTC(2026, 8, 25)) : null,
  }))).returning();
  await database.insert(schema.userJobs).values(extra.map((job, i) => ({ userId: user.id, jobId: job.id, keywordMatched: true, locationOk: true, inTable: i % 11 !== 0, fitScore: i % 5 === 0 ? null : (i % 4) * 20 })));
  const all = await database.select({ id: schema.jobs.id, title: schema.jobs.title }).from(schema.jobs).orderBy(schema.jobs.externalKey);
  await database.update(schema.jobs).set({ firstSeenAt: new Date(Date.now() - 2 * 86400000) }).where(inArray(schema.jobs.id, all.slice(0, 20).map((job) => job.id)));
  await database.insert(schema.decisions).values(all.filter((_, i) => i % 6 === 0).map((job, i) => ({ userId: user.id, jobId: job.id, decision: i % 2 ? "apply" as const : "skip" as const, jobTitle: job.title, companyName: "Acme" })));
  await database.update(schema.userJobs).set({ archivedAt: new Date() }).where(inArray(schema.userJobs.jobId, all.filter((_, i) => i % 13 === 0).map((job) => job.id)));
  const now = new Date();
  const cases: Array<[Record<string, string>, boolean]> = [
    [{ view: "auto-matched" }, false],
    [{ view: "auto-matched", dir: "desc" }, false],
    [{ decision: "all", sort: "fit", dir: "desc" }, false],
    [{ decision: "all", sort: "fit", dir: "asc" }, false],
    [{ decision: "all", sort: "company" }, false],
    [{ decision: "all", sort: "company", dir: "desc" }, false],
    [{ decision: "all", sort: "title" }, false],
    [{ decision: "all", sort: "location", dir: "desc" }, false],
    [{ decision: "all", sort: "liveFor" }, false],
    [{ decision: "all", sort: "firstSeen", dir: "desc" }, false],
    [{ decision: "all", sort: "decided", dir: "desc" }, false],
    [{ view: "archived", sort: "company" }, true],
  ];
  for (const [params, archived] of cases) {
    const filters = parseRolesFilters(params);
    for (const offset of [0, 50, 100]) {
      const read = (await fetchRoleRows(user.id, filters, archived, { offset, limit: 50, now })).map((row) => row.job.id);
      expect(read, `${JSON.stringify(params)} at ${offset}`).toEqual(await legacyRoleIds(user.id, filters, archived, { offset, limit: 50, now }));
    }
    // Page by page, and by the export's cursor, the whole view comes back once, in one order.
    const whole = await legacyRoleIds(user.id, filters, archived, { limit: 1000, now });
    const paged: string[] = [];
    for (let offset = 0; offset < whole.length; offset += 50) paged.push(...(await fetchRoleRows(user.id, filters, archived, { offset, limit: 50, now })).map((row) => row.job.id));
    expect(paged, JSON.stringify(params)).toEqual(whole);
    const cursored: string[] = [];
    let after: RoleCursor | null = null;
    for (;;) {
      const block: Array<{ job: { id: string }; cursor: RoleCursor }> = await fetchRoleRows(user.id, filters, archived, { after, limit: 37, now });
      cursored.push(...block.map((row) => row.job.id));
      if (block.length < 37) break;
      after = block.at(-1)!.cursor;
    }
    expect(cursored, JSON.stringify(params)).toEqual(whole);
  }
  // The rows are the page's hydrated rows, not bare keys: every column the table renders is there.
  const [first] = await fetchRoleRows(user.id, parseRolesFilters({ decision: "all", sort: "company" }), false, { limit: 1, now });
  expect(first).toMatchObject({ company: { name: "Acme" }, sourceType: "html", stage: expect.any(String) });
  expect(first!.job.descriptionText).toBeNull();
});

it("picks the page's keys from the account's own index for the Matched view", async () => {
  const filters = parseRolesFilters({ view: "auto-matched" });
  const sent: Array<{ text: string; values: unknown[] }> = [];
  const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
  const spy = vi.spyOn(pool, "query").mockImplementation(((...args: unknown[]) => {
    const first = args[0] as string | { text: string; values?: unknown[] };
    if (typeof first !== "string") sent.push({ text: first.text, values: first.values ?? (args[1] as unknown[]) ?? [] });
    return query(...args);
  }) as never);
  try { await fetchRoleRows(user.id, filters, false); } finally { spy.mockRestore(); }
  const statement = sent.find((entry) => entry.text.includes("json_build_array("))!;
  const where = statement.text.slice(statement.text.indexOf(" where "));
  // The view is said as the columns the index leads with, not through the case expression the
  // planner cannot see into: that is what lets `user_jobs_table_idx` serve Matched on a real table
  // (the plan itself depends on the statistics, so it is checked on the benchmark database).
  expect(where).not.toContain("'auto-matched'");
  expect(where).toContain(`"user_jobs"."archived_at" is null and "user_jobs"."in_table"`);
  // Asking for every freshness state asks for nothing, so no per-row expression is left to filter on.
  expect(where).not.toMatch(/ in \(\$\d+, \$\d+, \$\d+\)/);
  // The page's keys are chosen before the wide columns are joined, from the same conditions.
  expect(statement.text).toMatch(/"jobs"\."id" in \(select page_keys\.job_id from \(+select "user_jobs"\."job_id" from "user_jobs"/);
});
