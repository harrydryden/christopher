import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { sql } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { ensureTestUser } from "@/test/auth";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
vi.mock("@/lib/db", () => ({ db: () => database }));
import { getReasonTagEditor, REASON_TAG_PAGE_SIZE } from "./learning";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
}, 120_000);
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate decisions, tag_vocabulary, users restart identity cascade`);
});

it("reaches the twenty-first standing decision in stable order without including another account", async () => {
  const owner = await ensureTestUser(database, "tag-owner@example.com");
  const other = await ensureTestUser(database, "tag-other@example.com");
  const createdAt = new Date("2026-09-01T12:00:00Z");
  const mine = await database.insert(schema.decisions).values(Array.from({ length: 24 }, (_, index) => ({
    userId: owner.id, decision: "skip" as const, reason: "Not for me", jobTitle: `Owner role ${index + 1}`,
    companyName: "Acme", createdAt,
  }))).returning();
  await database.insert(schema.decisions).values({ userId: owner.id, decision: "skip", reason: "Old version",
    jobTitle: "Superseded role", companyName: "Acme", createdAt, superseded: true });
  await database.insert(schema.decisions).values({ userId: other.id, decision: "skip", reason: "Private",
    jobTitle: "Other account role", companyName: "Private", createdAt });

  const first = await getReasonTagEditor(owner.id);
  const second = await getReasonTagEditor(owner.id, "2");
  const expected = mine.map(row => row.id).sort((a, b) => b.localeCompare(a));
  expect(REASON_TAG_PAGE_SIZE).toBe(20);
  expect(first).toMatchObject({ page: 1, totalPages: 2, totalDecisions: 24 });
  expect(first.recent.map(row => row.id)).toEqual(expected.slice(0, 20));
  expect(second).toMatchObject({ page: 2, totalPages: 2, totalDecisions: 24 });
  expect(second.recent.map(row => row.id)).toEqual(expected.slice(20));
  expect(second.recent[0]?.jobTitle).toMatch(/^Owner role /);
  expect([...first.recent, ...second.recent].map(row => row.jobTitle)).not.toContain("Other account role");
  const outsider = await getReasonTagEditor(other.id);
  expect(outsider).toMatchObject({ page: 1, totalPages: 1, totalDecisions: 1 });
  expect(outsider.recent.map(row => row.jobTitle)).toEqual(["Other account role"]);
});

it("clamps out-of-range pages and treats invalid inputs as page one", async () => {
  const owner = await ensureTestUser(database, "tag-bounds@example.com");
  await database.insert(schema.decisions).values(Array.from({ length: 21 }, (_, index) => ({
    userId: owner.id, decision: "apply" as const, jobTitle: `Role ${index + 1}`, companyName: "Acme",
  })));
  for (const value of [undefined, "0", "-1", "1.5", "junk", "9007199254740992", " 2", "2e1", ["2"]]) {
    const result = await getReasonTagEditor(owner.id, value);
    expect(result.page).toBe(1);
    expect(result.recent).toHaveLength(20);
  }
  const last = await getReasonTagEditor(owner.id, "99999999");
  expect(last.page).toBe(2);
  expect(last.recent).toHaveLength(1);
  const empty = await getReasonTagEditor(crypto.randomUUID(), "99999999");
  expect(empty).toMatchObject({ page: 1, totalPages: 1, totalDecisions: 0, recent: [] });
});
