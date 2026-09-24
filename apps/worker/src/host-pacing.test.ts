import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createDb } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { reserveHostTurn } from "./context";

/**
 * A host's turns in the shared pacing table. A turn further off than the fetcher will wait is not
 * taken: the request is requeued, and a turn nobody used must not push everyone behind it back.
 */
const { db, pool } = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test");
beforeAll(() => runMigrations(db));
beforeEach(() => db.execute(sql`truncate host_pacing`));
afterAll(async () => { await db.execute(sql`truncate host_pacing`); await pool.end(); });

const nextAt = async (host: string) => {
  const rows = await db.execute<{ ms: number }>(sql`select extract(epoch from (next_at - now())) * 1000 as ms from host_pacing where host = ${host}`);
  return Number(rows.rows[0]?.ms);
};

it("takes a free host's turn at once and spaces the next one by its delay", async () => {
  expect(await reserveHostTurn(db, "free.example", 2_000, 30_000)).toBe(0);
  expect(await nextAt("free.example")).toBeGreaterThan(1_500);
  // The next request waits for the turn after it, and moves the schedule on by one more delay.
  const wait = await reserveHostTurn(db, "free.example", 2_000, 30_000);
  expect(wait).toBeGreaterThan(1_500);
  expect(wait).toBeLessThanOrEqual(2_000);
  expect(await nextAt("free.example")).toBeGreaterThan(3_500);
});

it("reports a turn beyond the wait without taking it or moving the host's schedule", async () => {
  // The host asked us to come back in two minutes.
  await db.execute(sql`insert into host_pacing (host, next_at) values ('busy.example', now() + interval '120 seconds')`);
  const before = await nextAt("busy.example");
  const wait = await reserveHostTurn(db, "busy.example", 2_000, 30_000);
  expect(wait).toBeGreaterThan(30_000);
  expect(wait).toBeGreaterThan(110_000);
  // Unchanged: a hundred requests bounced off a busy host no longer push it a hundred turns back.
  expect(await nextAt("busy.example")).toBeLessThanOrEqual(before);
  expect(await nextAt("busy.example")).toBeGreaterThan(110_000);
});
