/**
 * The pool against a real database: what happens when a connection dies under it.
 *
 * Requires a database: set TEST_DATABASE_URL (defaults to the local col_test database).
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, namedStatementsFor, poolErrorCount, poolStats, serverTimeouts, timeRoundTrip, type SlowQuery } from "./client";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/col_test";
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

describe("server-side time limits", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("start every connection with a statement ceiling and an idle-in-transaction limit", async () => {
    const { db, pool } = createDb(DATABASE_URL, { max: 1 });
    try {
      const { rows } = await db.execute<{ statement: string; idle: string }>(sql`select current_setting('statement_timeout') as statement, current_setting('idle_in_transaction_session_timeout') as idle`);
      expect(rows[0]).toEqual({ statement: "5min", idle: "1min" });
    } finally {
      await pool.end();
    }
  });

  it("have the server cancel a statement that runs past its ceiling", async () => {
    const { db, pool } = createDb(DATABASE_URL, { max: 1, statementTimeoutMs: 100 });
    try {
      await expect(db.execute(sql`select pg_sleep(2)`)).rejects.toMatchObject({ cause: { code: "57014" } });
      // The connection survives the cancellation and serves the next query.
      expect((await db.execute<{ one: number }>(sql`select 1 as one`)).rows[0]?.one).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("are overridden by the caller, then by DATABASE_STATEMENT_TIMEOUT_MS, and 0 turns them off", () => {
    const direct = "postgres://u:p@127.0.0.1:5432/col";
    expect(serverTimeouts(direct, { statementTimeoutMs: 30_000 })).toEqual({ statement_timeout: 30_000, idle_in_transaction_session_timeout: 60_000 });
    vi.stubEnv("DATABASE_STATEMENT_TIMEOUT_MS", "45000");
    expect(serverTimeouts(direct)).toMatchObject({ statement_timeout: 45_000 });
    expect(serverTimeouts(direct, { statementTimeoutMs: 30_000 })).toMatchObject({ statement_timeout: 30_000 });
    expect(serverTimeouts(direct, { statementTimeoutMs: 0, idleInTransactionTimeoutMs: 0 })).toEqual({});
  });

  it("are not sent to Render's transaction pooler, which refuses unknown startup parameters", () => {
    for (const url of [
      "postgres://u:p@dpg-example-a.frankfurt-postgres.render.com:6432/col",
      "postgres://u:p@dpg-example-a:6432/col",
      "postgres://u:p@dpg-example-a.frankfurt-postgres.render.com:5432/col?port=6432",
    ]) {
      expect(serverTimeouts(url, { statementTimeoutMs: 30_000 })).toEqual({});
      const { pool } = createDb(url);
      expect(pool.options).not.toHaveProperty("statement_timeout");
      expect(pool.options).not.toHaveProperty("idle_in_transaction_session_timeout");
      void pool.end();
    }
    expect(serverTimeouts("postgres://u:p@dpg-example-a.frankfurt-postgres.render.com:5432/col")).toMatchObject({ statement_timeout: 300_000 });
  });
});

describe("the slow-query report", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("names the statement by the start of its text", async () => {
    const seen: SlowQuery[] = [];
    const { db, pool } = createDb(DATABASE_URL, { max: 1, onSlowQuery: query => seen.push(query) });
    try {
      await db.execute(sql`select   pg_sleep(0.3),
        ${"a parameter the report must not carry"}::text as p`);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.durationMs).toBeGreaterThanOrEqual(250);
      expect(seen[0]!.statement).toBe("select pg_sleep(0.3), $1::text as p");
    } finally {
      await pool.end();
    }
  });

  it("is an info line with a timestamp, and is not written at all when LOG_LEVEL is above info", async () => {
    const writes = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { db, pool } = createDb(DATABASE_URL, { max: 1 });
    try {
      vi.stubEnv("LOG_LEVEL", "warn");
      await db.execute(sql`select pg_sleep(0.3)`);
      expect(writes.mock.calls.filter(([line]) => String(line).includes("slow_database_query"))).toHaveLength(0);
      vi.stubEnv("LOG_LEVEL", "info");
      await db.execute(sql`select pg_sleep(0.3)`);
      const lines = writes.mock.calls.map(([line]) => String(line)).filter(line => line.includes("slow_database_query"));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ level: "info", event: "slow_database_query", statement: "select pg_sleep(0.3)", t: expect.any(String) });
    } finally {
      writes.mockRestore();
      await pool.end();
    }
  });
});

describe("the endpoint a serverless deployment connects to", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("is flagged once when a Vercel process opens a pool on Render's direct endpoint", async () => {
    const writes = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const flagged = () => writes.mock.calls.filter(([line]) => String(line).includes("database_direct_endpoint")).length;
    const open = (url: string) => { const { pool } = createDb(url); void pool.end(); };
    const direct = "postgres://u:p@dpg-example-a.frankfurt-postgres.render.com:5432/col";
    open(direct);
    expect(flagged()).toBe(0);
    vi.stubEnv("VERCEL", "1");
    open("postgres://u:p@dpg-example-a.frankfurt-postgres.render.com:6432/col");
    open("postgres://u:p@127.0.0.1:5432/col");
    expect(flagged()).toBe(0);
    open(direct);
    open(direct);
    expect(flagged()).toBe(1);
    // The line names the fix and never the address, which carries the password.
    const line = writes.mock.calls.map(([text]) => String(text)).find(text => text.includes("database_direct_endpoint"))!;
    expect(line).toContain("6432");
    expect(line).not.toContain("u:p@");
  });
});

describe("idle connections", () => {
  it("are closed after 30 seconds unless the caller keeps them longer, and are kept alive at the socket", async () => {
    const plain = createDb("postgres://u:p@127.0.0.1:5432/col");
    const kept = createDb("postgres://u:p@dpg-example-a.frankfurt-postgres.render.com:6432/col", { idleTimeoutMillis: 120_000 });
    try {
      expect(plain.pool.options).toMatchObject({ idleTimeoutMillis: 30_000, keepAlive: true, connectionTimeoutMillis: 10_000 });
      expect(kept.pool.options).toMatchObject({ idleTimeoutMillis: 120_000, keepAlive: true, connectionTimeoutMillis: 10_000 });
      // A longer idle time is not a startup parameter: PgBouncer on 6432 still receives none of the timeouts.
      expect(kept.pool.options).not.toHaveProperty("statement_timeout");
      expect(kept.pool.options).not.toHaveProperty("idle_in_transaction_session_timeout");
    } finally {
      await Promise.all([plain.pool.end(), kept.pool.end()]);
    }
  });

  it("really are closed once the idle time has passed", async () => {
    const { db, pool } = createDb(DATABASE_URL, { max: 1, idleTimeoutMillis: 200 });
    try {
      await db.execute(sql`select 1`);
      expect(pool.totalCount).toBe(1);
      await vi.waitFor(() => expect(pool.totalCount).toBe(0), { timeout: 3_000 });
    } finally {
      await pool.end();
    }
  });
});

describe("the round trip to the database", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("is one select 1 on an open connection, timed to a tenth of a millisecond", async () => {
    const ticks = [1_000, 1_004.26];
    const queries: string[] = [];
    const ms = await timeRoundTrip({ query: async (text: string) => { queries.push(text); } }, () => ticks.shift()!);
    expect(ms).toBe(4.3);
    expect(queries).toEqual(["select 1"]);
  });

  it("is logged once per process, after the first query of a pool that asks, and never carries the address", async () => {
    const writes = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const lines = () => writes.mock.calls.map(([line]) => String(line)).filter(line => line.includes("database_round_trip"));
    const quiet = createDb(DATABASE_URL, { max: 1 });
    const first = createDb(DATABASE_URL, { max: 2, reportRoundTrip: true });
    const second = createDb(DATABASE_URL, { max: 1, reportRoundTrip: true });
    try {
      await quiet.db.execute(sql`select 1`);
      expect(lines()).toHaveLength(0);
      // Measured once the first query has handed its connection back, never in front of it.
      await first.db.execute(sql`select 1`);
      await vi.waitFor(() => expect(lines()).toHaveLength(1));
      const logged = JSON.parse(lines()[0]!);
      expect(logged).toMatchObject({ level: "info", event: "database_round_trip", endpoint: "other", ms: expect.any(Number) });
      expect(logged.samplesMs).toHaveLength(3);
      expect(logged.ms).toBe(Math.min(...logged.samplesMs));
      expect(logged.ms).toBeGreaterThanOrEqual(0);
      expect(lines()[0]).not.toContain("postgres:postgres@");
      // A second connection, or a second pool, in the same process adds nothing.
      await Promise.all([first.db.execute(sql`select pg_sleep(0.05)`), first.db.execute(sql`select pg_sleep(0.05)`)]);
      await second.db.execute(sql`select 1`);
      expect(first.pool.totalCount).toBe(2);
      expect(lines()).toHaveLength(1);
    } finally {
      writes.mockRestore();
      await Promise.all([quiet.pool.end(), first.pool.end(), second.pool.end()]);
    }
  });
});

describe("named statements", () => {
  /** How many statements named `named_statement_probe` the pool's one connection holds after running one. */
  const namedOnConnection = async (namedStatements?: boolean) => {
    const { db, pool } = createDb(DATABASE_URL, { max: 1, ...(namedStatements === undefined ? {} : { namedStatements }) });
    try {
      await db.select({ one: sql<number>`1` }).from(sql`(select 1) as t`).prepare("named_statement_probe").execute();
      const { rows } = await db.execute<{ n: number }>(sql`select count(*)::int as n from pg_prepared_statements where name = 'named_statement_probe'`);
      return rows[0]!.n;
    } finally {
      await pool.end();
    }
  };

  it("are prepared on a direct connection, once per connection", async () => {
    expect(await namedOnConnection()).toBe(1);
  });

  it("are sent unnamed when the pool says so: a transaction pooler loses them between transactions", async () => {
    expect(await namedOnConnection(false)).toBe(0);
  });

  it("are off by default on a transaction pooler's URL: Render's 6432, or a host named as a pooler", () => {
    expect(namedStatementsFor("postgres://u:p@dpg-abc.frankfurt-postgres.render.com:6432/db")).toBe(false);
    expect(namedStatementsFor("postgres://u:p@dpg-abc.frankfurt-postgres.render.com/db?port=6432")).toBe(false);
    expect(namedStatementsFor("postgres://u:p@ep-cool-name-pooler.eu-central-1.aws.neon.tech/db")).toBe(false);
    expect(namedStatementsFor("postgres://u:p@dpg-abc.frankfurt-postgres.render.com:5432/db")).toBe(true);
    expect(namedStatementsFor("postgres://u:p@dpg-abc-a:5432/db")).toBe(true);
    expect(namedStatementsFor(DATABASE_URL)).toBe(true);
  });
});
