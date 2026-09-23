/**
 * The migration runner against a real database. The probe migrations live in a temporary folder
 * and record themselves in their own table in their own schema, so nothing here touches the
 * journal the other suites migrate with.
 *
 * Requires a database: set TEST_DATABASE_URL (defaults to the local ava_test database).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createDb } from "./client";
import { readJournal, runMigrations, unappliedMigrations, type JournalEntry } from "./migrate";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";
const { db, pool } = createDb(DATABASE_URL, { max: 2 });
const probe = { migrationsSchema: "migration_probe", migrationsTable: "__probe_migrations" };
let folder: string;

/** A migrations folder holding exactly these entries, each creating one probe table unless given its own SQL. */
async function writeProbeFolder(entries: Array<JournalEntry & { sql?: string }>) {
  await rm(folder, { recursive: true, force: true });
  await mkdir(join(folder, "meta"), { recursive: true });
  await writeFile(join(folder, "meta", "_journal.json"), JSON.stringify({
    version: "7", dialect: "postgresql", entries: entries.map(({ idx, when, tag }) => ({ idx, when, tag, version: "7", breakpoints: true })),
  }));
  for (const entry of entries) {
    await writeFile(join(folder, `${entry.tag}.sql`), entry.sql ?? `CREATE TABLE IF NOT EXISTS "migration_probe"."${entry.tag}" ("id" integer);`);
  }
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "ava-migrations-"));
  await runMigrations(db);
});
afterEach(() => db.execute(sql`drop schema if exists migration_probe cascade`));
afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
  await pool.end();
});

describe("runMigrations", () => {
  it("leaves every entry of the real journal recorded as applied", async () => {
    const journal = readJournal(fileURLToPath(new URL("../drizzle", import.meta.url)));
    const recorded = await db.execute<{ created_at: string }>(sql`select created_at from drizzle.__drizzle_migrations`);
    expect(unappliedMigrations(journal, recorded.rows.map(row => row.created_at))).toEqual([]);
  });

  it("refuses a journal whose entry the migrator would skip, before it connects", async () => {
    await writeProbeFolder([
      { idx: 0, when: 1000, tag: "0000_first" },
      { idx: 1, when: 3000, tag: "0001_second" },
      { idx: 2, when: 2000, tag: "0002_generated_today" },
    ]);
    await expect(runMigrations(db, { ...probe, migrationsFolder: folder })).rejects.toThrow(/0002_generated_today.*not later than 0001_second/);
    const created = await db.execute(sql`select 1 from information_schema.schemata where schema_name = 'migration_probe'`);
    expect(created.rows).toHaveLength(0);
  });

  it("fails loudly when the database already has a later migration than a pending entry", async () => {
    // The shape of the production incident: another branch's migration, dated later, was applied
    // first, so the migrator passes over this one and would otherwise report success.
    await writeProbeFolder([{ idx: 0, when: 1000, tag: "0000_first" }]);
    await runMigrations(db, { ...probe, migrationsFolder: folder });
    await db.execute(sql`insert into migration_probe.__probe_migrations (hash, created_at) values ('from-another-branch', 5000)`);
    await writeProbeFolder([
      { idx: 0, when: 1000, tag: "0000_first" },
      { idx: 1, when: 4000, tag: "0001_skipped" },
    ]);
    await expect(runMigrations(db, { ...probe, migrationsFolder: folder })).rejects.toThrow(/0001_skipped are in the journal but were not applied/);
    const table = await db.execute(sql`select to_regclass('migration_probe."0001_skipped"') as present`);
    expect(table.rows[0]?.present).toBeNull();
  });

  it("releases the migration lock after a failed run, so the next run is not blocked", async () => {
    await writeProbeFolder([{ idx: 0, when: 1000, tag: "0000_first" }]);
    await runMigrations(db, { ...probe, migrationsFolder: folder });
    await db.execute(sql`insert into migration_probe.__probe_migrations (hash, created_at) values ('from-another-branch', 5000)`);
    await writeProbeFolder([{ idx: 0, when: 1000, tag: "0000_first" }, { idx: 1, when: 4000, tag: "0001_skipped" }]);
    await expect(runMigrations(db, { ...probe, migrationsFolder: folder })).rejects.toThrow();
    // Another session can take the lock at once: the failed run's session is gone, not pooled.
    const other = await pool.connect();
    try {
      const taken = await other.query<{ locked: boolean }>("select pg_try_advisory_lock(74233101) as locked");
      expect(taken.rows[0]?.locked).toBe(true);
      await other.query("select pg_advisory_unlock(74233101)");
    } finally {
      other.release();
    }
  });
});

describe("runMigrations and other sessions' locks", () => {
  it("waits a bounded time for another process's migration lock, then says so", async () => {
    await writeProbeFolder([{ idx: 0, when: 1000, tag: "0000_first" }]);
    const other = await pool.connect();
    try {
      await other.query("select pg_advisory_lock(74233101)");
      await expect(runMigrations(db, { ...probe, migrationsFolder: folder, lockTimeout: "50ms", attempts: 2 }))
        .rejects.toThrow(/Gave up on the migration lock after 2 attempts/);
      await other.query("select pg_advisory_unlock(74233101)");
    } finally {
      other.release();
    }
    // Once the other process is done, the same call goes through.
    await runMigrations(db, { ...probe, migrationsFolder: folder, lockTimeout: "50ms", attempts: 2 });
  });

  it("gives up on a table lock after lock_timeout instead of queueing every reader behind it, and retries", async () => {
    const single = createDb(DATABASE_URL, { max: 1 });
    const blocker = await pool.connect();
    try {
      await db.execute(sql`create schema migration_probe`);
      await db.execute(sql`create table migration_probe.target (id integer)`);
      await writeProbeFolder([{ idx: 0, when: 1000, tag: "0000_alter_target", sql: `ALTER TABLE "migration_probe"."target" ADD COLUMN IF NOT EXISTS "added" integer;` }]);
      // A long read holds the table; the ALTER needs an exclusive lock and must not wait it out.
      await blocker.query("begin");
      await blocker.query("lock table migration_probe.target in access share mode");
      const waits: number[] = [];
      await runMigrations(single.db, {
        ...probe, migrationsFolder: folder, lockTimeout: "50ms", attempts: 3,
        retryWait: async attempt => {
          waits.push(attempt);
          await blocker.query("commit");
        },
      });
      expect(waits).toEqual([1]);
      const column = await db.execute(sql`select 1 from information_schema.columns where table_schema = 'migration_probe' and table_name = 'target' and column_name = 'added'`);
      expect(column.rows).toHaveLength(1);
      // The session goes back to the pool with its own limits, not the migration's.
      const settings = await single.db.execute<{ lock: string; statement: string }>(sql`select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement`);
      expect(settings.rows[0]).toEqual({ lock: "0", statement: "5min" });
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
      await single.pool.end();
    }
  });

  it("stops retrying a table lock after its attempts, naming what it gave up on", async () => {
    const blocker = await pool.connect();
    try {
      await db.execute(sql`create schema migration_probe`);
      await db.execute(sql`create table migration_probe.target (id integer)`);
      await writeProbeFolder([{ idx: 0, when: 1000, tag: "0000_alter_target", sql: `ALTER TABLE "migration_probe"."target" ADD COLUMN IF NOT EXISTS "added" integer;` }]);
      await blocker.query("begin");
      await blocker.query("lock table migration_probe.target in access share mode");
      await expect(runMigrations(db, { ...probe, migrationsFolder: folder, lockTimeout: "50ms", attempts: 2, retryWait: async () => {} }))
        .rejects.toThrow(/Gave up on the migrations after 2 attempts/);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
    }
  });
});
