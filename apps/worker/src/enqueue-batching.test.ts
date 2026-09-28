/**
 * Worker writes that queue one task per row do it in one statement for the batch, not one each.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { createDb, queueScoring, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { testDatabaseUrl } from "./test-users";
import { queueMissingCompanyProfiles } from "./handlers/companies";
import type { WorkerDeps } from "./context";

let db: Db;
let pool: ReturnType<typeof createDb>["pool"];
const sent: string[] = [];
const original = pg.Client.prototype.query;

beforeAll(async () => {
  // Before the pool opens: each connection binds the query method it finds when it connects.
  (pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown }).query = function (this: pg.Client, ...args: unknown[]) {
    const q = args[0] as { text?: string } | string;
    const text = typeof q === "string" ? q : q?.text;
    if (text) sent.push(text);
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };
  ({ db, pool } = createDb(testDatabaseUrl("ava-batching-test"), { max: 1 }));
  await runMigrations(db);
}, 60_000);
afterAll(async () => {
  pg.Client.prototype.query = original;
  await pool.end();
});
beforeEach(async () => { await db.execute(sql`truncate tasks, companies restart identity cascade`); });

it("queues a profile for every unprofiled company in one insert", async () => {
  await db.insert(schema.companies).values(Array.from({ length: 6 }, (_, i) => ({ name: `Co ${i}`, domain: `co${i}.example`, homepageUrl: `https://co${i}.example` })));
  sent.length = 0;
  const deps = { db, now: () => new Date() } as unknown as WorkerDeps;
  expect(await queueMissingCompanyProfiles(deps)).toBe(6);
  expect(sent.filter(text => /^insert into "tasks"/i.test(text))).toHaveLength(1);
  // A second pass finds them all already waiting and queues nothing.
  expect(await queueMissingCompanyProfiles(deps)).toBe(0);
  const queued = await db.execute<{ n: number }>(sql`select count(*)::int as n from tasks where type = 'profile_company'`);
  expect(queued.rows[0]!.n).toBe(6);
});

it("queues scores through the ordinary enqueue, so a listening worker is woken, and marks the views in one statement", async () => {
  const pairs = Array.from({ length: 3 }, () => ({ userId: randomUUID(), jobId: randomUUID() }));
  sent.length = 0;
  expect(await queueScoring(db, pairs, new Date())).toBe(3);
  expect(sent.filter(text => /^insert into "tasks"/i.test(text))).toHaveLength(1);
  expect(sent.filter(text => /pg_notify/.test(text))).toHaveLength(1);
  expect(sent.filter(text => /^update user_jobs/i.test(text))).toHaveLength(1);
  // The same work asked for again is already waiting: nothing is inserted, and nobody is woken.
  sent.length = 0;
  expect(await queueScoring(db, pairs, new Date())).toBe(0);
  expect(sent.filter(text => /pg_notify/.test(text))).toHaveLength(0);
});
