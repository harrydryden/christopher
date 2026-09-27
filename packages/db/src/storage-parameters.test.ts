/**
 * Migration 0043's database settings, read back from the catalogue after migrating: per-table
 * autovacuum thresholds for the tables that churn, and JIT off for the database, which a role that
 * does not own the database skips with a notice instead of failing the migration.
 *
 * Requires a database: set TEST_DATABASE_URL (defaults to the local ava_test database).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createDb } from "./client";
import { runMigrations } from "./migrate";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";
const { db, pool } = createDb(DATABASE_URL, { max: 1 });
beforeAll(() => runMigrations(db));
afterAll(() => pool.end());

const EXPECTED: Record<string, Record<string, string>> = {
  tasks: {
    autovacuum_vacuum_scale_factor: "0.02", autovacuum_vacuum_threshold: "500",
    autovacuum_analyze_scale_factor: "0.02", autovacuum_analyze_threshold: "500",
  },
  job_events: { autovacuum_vacuum_scale_factor: "0.05", autovacuum_analyze_scale_factor: "0.02", autovacuum_vacuum_insert_scale_factor: "0.05" },
  scans: { autovacuum_vacuum_scale_factor: "0.05", autovacuum_analyze_scale_factor: "0.02", autovacuum_vacuum_insert_scale_factor: "0.05" },
  ai_calls: { autovacuum_vacuum_insert_scale_factor: "0.05", autovacuum_analyze_scale_factor: "0.05" },
  user_jobs: { autovacuum_vacuum_scale_factor: "0.05", autovacuum_analyze_scale_factor: "0.02" },
};

describe("per-table autovacuum", () => {
  it.each(Object.entries(EXPECTED))("is set on %s exactly as the migration writes it", async (table, expected) => {
    const { rows } = await db.execute<{ options: string[] | null }>(sql`
      select c.reloptions as options from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = ${table}`);
    const options = Object.fromEntries((rows[0]?.options ?? []).map(option => option.split("=") as [string, string]));
    expect(options).toEqual(expected);
  });

  it("leaves every other table on the server's defaults", async () => {
    const { rows } = await db.execute<{ table: string }>(sql`
      select c.relname as table from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.reloptions is not null order by 1`);
    expect(rows.map(row => row.table).sort()).toEqual(Object.keys(EXPECTED).sort());
  });
});

describe("JIT", () => {
  it("is off for every session opened on this database after the migration", async () => {
    const { rows } = await db.execute<{ config: string[] | null }>(sql`
      select s.setconfig as config from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase
      where d.datname = current_database() and s.setrole = 0`);
    expect(rows[0]?.config ?? []).toContain("jit=off");
    const fresh = createDb(DATABASE_URL, { max: 1 });
    try {
      expect((await fresh.db.execute<{ jit: string }>(sql`select current_setting('jit') as jit`)).rows[0]?.jit).toBe("off");
    } finally {
      await fresh.pool.end();
    }
  });

  it("is skipped with a notice, not an error, when the migrating role does not own the database", async () => {
    const migration = readFileSync(fileURLToPath(new URL("../drizzle/0043_autovacuum_jit_snapshots.sql", import.meta.url)), "utf8");
    const guarded = migration.slice(migration.indexOf("DO $$"));
    expect(guarded).toMatch(/^DO \$\$[\s\S]*\$\$;\s*$/);
    const client = await pool.connect();
    const notices: string[] = [];
    const listen = (notice: { message?: string }) => notices.push(notice.message ?? "");
    client.on("notice", listen);
    try {
      await client.query("begin");
      await client.query("create role ava_test_not_owner nologin");
      await client.query("set local role ava_test_not_owner");
      await client.query(guarded);
      expect(notices.some(message => message.includes("jit left as it is") && message.includes("ava_test_not_owner"))).toBe(true);
    } finally {
      await client.query("rollback");
      client.off("notice", listen);
      client.release();
    }
  });
});
