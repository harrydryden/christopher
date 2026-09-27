/**
 * Who holds the database's backends: connections name themselves with `application_name`, and
 * `databaseBackends` counts them from `pg_stat_activity` against the usable ceiling.
 *
 * Requires a database: set TEST_DATABASE_URL (defaults to the local ava_test database).
 */
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client";
import { BACKENDS_ALERT_AT, WEB_BACKENDS_CAP, databaseBackends } from "./backends";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";
const observer = createDb(DATABASE_URL, { max: 2, applicationName: "ava-test-observer" });
afterAll(() => observer.pool.end());

describe("application_name", () => {
  it("is what every connection of a pool reports, and nothing is reported when none is given", async () => {
    const named = createDb(DATABASE_URL, { max: 1, applicationName: "ava-web" });
    const unnamed = createDb(DATABASE_URL, { max: 1 });
    try {
      const name = async (db: typeof named.db) => (await db.execute<{ name: string }>(sql`select current_setting('application_name') as name`)).rows[0]?.name;
      expect(await name(named.db)).toBe("ava-web");
      expect(await name(unnamed.db)).toBe("");
      // A connection string that names one wins, so an operator's DATABASE_URL still decides.
      const url = new URL(DATABASE_URL);
      url.searchParams.set("application_name", "from-the-url");
      const overridden = createDb(url.href, { max: 1, applicationName: "ava-web" });
      try {
        expect(await name(overridden.db)).toBe("from-the-url");
      } finally {
        await overridden.pool.end();
      }
    } finally {
      await Promise.all([named.pool.end(), unnamed.pool.end()]);
    }
  });

  it("is sent to Render's pooler too, as the only startup parameter there", async () => {
    const { pool } = createDb("postgres://u:p@dpg-example-a.frankfurt-postgres.render.com:6432/ava", { applicationName: "ava-web", statementTimeoutMs: 30_000 });
    try {
      expect(pool.options).toMatchObject({ application_name: "ava-web" });
      expect(pool.options).not.toHaveProperty("statement_timeout");
      expect(pool.options).not.toHaveProperty("idle_in_transaction_session_timeout");
    } finally {
      await pool.end();
    }
  });
});

describe("databaseBackends", () => {
  it("counts client backends per application, idle and active, against the usable ceiling", async () => {
    const worker = createDb(DATABASE_URL, { max: 2, applicationName: "ava-test-worker" });
    const held = await worker.pool.connect();
    const idle = await worker.pool.connect();
    idle.release();
    try {
      // One connection in an open transaction, one idle in the pool.
      await held.query("begin");
      await held.query("select 1");
      const backends = await databaseBackends(observer.db);
      expect(backends.byApplication["ava-test-worker"]).toEqual({ total: 2, active: 1 });
      // The observer's own statement is one of them.
      expect(backends.byApplication["ava-test-observer"]?.active).toBeGreaterThanOrEqual(1);
      const sum = Object.values(backends.byApplication).reduce((acc, row) => ({ total: acc.total + row.total, active: acc.active + row.active }), { total: 0, active: 0 });
      expect({ total: backends.total, active: backends.active }).toEqual(sum);
      const { rows } = await observer.db.execute<{ usable: number }>(sql`select current_setting('max_connections')::int - current_setting('superuser_reserved_connections')::int - current_setting('reserved_connections')::int as usable`);
      expect(backends.usable).toBe(rows[0]!.usable);
      expect(backends.total).toBeLessThanOrEqual(backends.usable);
    } finally {
      await held.query("rollback");
      held.release();
      await worker.pool.end();
    }
  });

  it("states the interface's cap below the alert, and the alert below Render's 100 usable backends", () => {
    expect(WEB_BACKENDS_CAP).toBe(60);
    expect(BACKENDS_ALERT_AT).toBe(80);
  });
});
