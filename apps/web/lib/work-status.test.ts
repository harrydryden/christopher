/**
 * What the work notice and its poll count as pending for one account: its followed companies'
 * scans and discovery, its own imports and gate re-evaluations, and nothing else. Every open roles
 * or companies tab asks this while work is in flight, so it is also read once rather than per task.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, schema, subscribeToCompany, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let a: User;
let b: User;
let mine: string;
let theirs: string;
vi.mock("@/lib/db", () => ({ db: () => database }));
import { companyWorkQuery, getCompanyWorkStatus } from "./work-status";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());
beforeEach(async () => {
  await database.execute(sql`truncate companies, tasks, users restart identity cascade`);
  a = await ensureTestUser(database, "work-a@example.com", "member");
  b = await ensureTestUser(database, "work-b@example.com", "member");
  const [one, two] = await database.insert(schema.companies).values([
    { name: "Mine", domain: "mine.example", homepageUrl: "https://mine.example" },
    { name: "Theirs", domain: "theirs.example", homepageUrl: "https://theirs.example" },
  ]).returning();
  mine = one!.id;
  theirs = two!.id;
  await subscribeToCompany(database, a.id, mine);
  await subscribeToCompany(database, b.id, theirs);
});

async function task(type: typeof schema.tasks.$inferInsert["type"], payload: Record<string, unknown>, status: "queued" | "running" | "done" = "queued") {
  const [row] = await database.insert(schema.tasks).values({ type, payload, status }).returning();
  return row!;
}

const status = (user: User) => getCompanyWorkStatus(user.id);

describe("getCompanyWorkStatus", () => {
  it("is not pending for anyone while only the daily run's fan-out task is queued", async () => {
    await task("run_daily", { trigger: "schedule", runDate: "2026-09-23" });
    expect((await status(a)).active).toBe(false);
    expect((await status(b)).active).toBe(false);
  });

  it("ignores a logo capture for a followed company", async () => {
    await task("discover", { companyId: mine, logoOnly: true, homepageUrl: "https://mine.example" });
    expect((await status(a)).active).toBe(false);
    await task("discover", { companyId: mine, reason: "manual" });
    expect((await status(a)).active).toBe(true);
  });

  it("counts a scan only for the accounts that follow its company", async () => {
    await task("scan_company", { companyId: mine });
    expect((await status(a)).active).toBe(true);
    expect((await status(b)).active).toBe(false);
  });

  it("counts an import only for the account that pasted it, and a gate re-evaluation for its account or all", async () => {
    await task("import_posting", { userId: b.id, companyId: mine, url: "https://mine.example/jobs/1" });
    expect((await status(a)).active).toBe(false);
    expect((await status(b)).active).toBe(true);

    await database.execute(sql`truncate tasks`);
    await task("reevaluate_gate", { userId: a.id });
    expect((await status(a)).active).toBe(true);
    expect((await status(b)).active).toBe(false);
    await task("reevaluate_gate", {});
    expect((await status(b)).active).toBe(true);
  });

  it("changes its version when a followed company's task moves, and only then", async () => {
    const scan = await task("scan_company", { companyId: mine });
    const other = await task("scan_company", { companyId: theirs });
    const before = (await status(a)).version;
    await database.update(schema.tasks).set({ status: "running" }).where(sql`id = ${other.id}`);
    expect((await status(a)).version).toBe(before);
    await database.update(schema.tasks).set({ status: "running" }).where(sql`id = ${scan.id}`);
    expect((await status(a)).version).not.toBe(before);
    await database.update(schema.tasks).set({ status: "done" }).where(sql`id = ${scan.id}`);
    expect(await status(a)).toMatchObject({ active: false });
  });

  it("reads the account's followed companies once per query, not once per queued task", async () => {
    const query = companyWorkQuery(a.id).toSQL();
    const plan = await pool.query(`explain ${query.sql}`, query.params);
    const text = plan.rows.map((row: { "QUERY PLAN": string }) => row["QUERY PLAN"]).join("\n");
    expect(text).toContain("hashed SubPlan");
    expect(text).not.toMatch(/company_id\)::text = \(tasks\.payload/);
  });
});
