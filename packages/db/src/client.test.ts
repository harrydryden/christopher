/**
 * The pool against a real database: what happens when a connection dies under it.
 *
 * Requires a database: set TEST_DATABASE_URL (defaults to the local ava_test database).
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, poolErrorCount, poolStats } from "./client";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";
// A second pool plays the operator (or the failover) that ends the first pool's connections.
const admin = createDb(DATABASE_URL, { max: 1 });
afterAll(() => admin.pool.end());

async function terminate(pid: number) {
  await admin.db.execute(sql`select pg_terminate_backend(${pid})`);
}

describe("a connection that dies under the pool", () => {
  it("is absorbed while idle, counted, and replaced by the next query", async () => {
    const { db, pool } = createDb(DATABASE_URL, { max: 1 });
    try {
      const before = poolErrorCount();
      const [row] = (await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows;
      expect(pool.idleCount).toBe(1);
      // Without a listener, the pool re-emits this as an unhandled `error` and the process exits.
      await terminate(row!.pid);
      await vi.waitFor(() => expect(poolErrorCount()).toBe(before + 1));
      expect(poolStats()?.errors).toBe(before + 1);
      const [again] = (await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows;
      expect(again!.pid).not.toBe(row!.pid);
    } finally {
      await pool.end();
    }
  });

  it("is absorbed while checked out, where the pool itself no longer listens", async () => {
    const { db, pool } = createDb(DATABASE_URL, { max: 1 });
    const client = await pool.connect();
    let released = false;
    try {
      const before = poolErrorCount();
      await client.query("begin");
      const pid = (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      // A server-side timeout ends an idle transaction exactly like this, between two queries.
      await terminate(pid);
      // The server's goodbye and the closed socket are two errors from one connection: counted once.
      await vi.waitFor(() => expect(poolErrorCount()).toBe(before + 1));
      await expect(client.query("select 1")).rejects.toThrow();
      expect(poolErrorCount()).toBe(before + 1);
      client.release(true);
      released = true;
      const answer = await db.execute<{ one: number }>(sql`select 1 as one`);
      expect(answer.rows[0]?.one).toBe(1);
    } finally {
      if (!released) client.release(true);
      await pool.end();
    }
  });
});
