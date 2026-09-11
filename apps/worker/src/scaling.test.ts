import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { createDb, schema } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { sql } from "drizzle-orm";
import { reserveAi } from "./budget";
import { selectExamples } from "./recommendation-context";
const { db, pool } = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
beforeAll(() => runMigrations(db));
beforeEach(() => db.execute(sql`truncate ai_calls, ai_reservations, ai_spend_periods`));
afterAll(() => pool.end());
it("atomically reserves concurrent spend and releases only unused capacity", async () => {
  const limits = { monthly: 1, daily: 1, discovery: 1 };
  const reservations = await Promise.all(Array.from({ length: 10 }, () => reserveAi(db, "A10", 0.6, limits)));
  expect(reservations.filter(Boolean)).toHaveLength(1);
  await reservations.find(Boolean)!(0.2);
  const second = await reserveAi(db, "A10", 0.6, limits);
  expect(second).not.toBeNull();
  await second!(null);
  expect(await reserveAi(db, "A10", 0.3, limits)).toBeNull();
});
it("preserves pre-upgrade spend and protects the discovery allowance", async () => {
  await db.insert(schema.aiCalls).values({ callSite: "A10", model: "fixture", costUsd: 0.8 });
  expect(await reserveAi(db, "A10", 0.3, { monthly: 1, daily: 10, discovery: 10 })).toBeNull();
  expect(await reserveAi(db, "A10", 0.1, { monthly: 10, daily: 10, discovery: 0.85 })).toBeNull();
  expect(await reserveAi(db, "CV", 0.1, { monthly: 10, daily: 10, discovery: 0.85 })).not.toBeNull();
});
it("selects bounded, deterministic examples across sectors and document relevance", () => {
  const rows = Array.from({ length: 1000 }, (_, n) => ({ name: `Company ${n}`, domain: `${n}.test`, sector: n > 950 ? "Robotics" : `Sector ${n % 15}` }));
  const examples = selectExamples(rows, "Robotics expansion in London");
  expect(examples).toHaveLength(40);
  expect(examples[0]!.sector).toBe("Robotics");
  expect(new Set(examples.map(r => r.sector)).size).toBeGreaterThan(10);
  expect(selectExamples([...rows].reverse(), "Robotics expansion in London")).toEqual(examples);
});

it("conservatively accounts for reservations abandoned by a crashed process", async () => {
  const limits = { monthly: 1, daily: 1, discovery: 1 };
  expect(await reserveAi(db, "A10", 0.8, limits)).not.toBeNull();
  await db.execute(sql`update ai_reservations set expires_at=now()-interval '1 minute'`);
  expect(await reserveAi(db, "A10", 0.3, limits)).toBeNull();
});

it("fences a reclaimed operation without holding a database transaction across external work", async () => {
  const { withResourceLease, LeaseBusyError } = await import("./lease");
  const deps = { db } as unknown as import("./context").WorkerDeps;
  const key = `test-operation-${Date.now()}`;
  await withResourceLease(deps, key, async locked => {
    await expect(withResourceLease(deps, key, async () => true)).rejects.toBeInstanceOf(LeaseBusyError);
    const transactions = await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and state='idle in transaction'`);
    expect(transactions.rows[0]!.n).toBe(0);
    await db.execute(sql`update resource_leases set owner=gen_random_uuid() where key=${key}`);
    await expect(db.transaction(async tx => locked.assertOwnership!(tx as unknown as typeof db))).rejects.toThrow("lease lost");
  });
  await db.execute(sql`delete from resource_leases where key=${key}`);
});
