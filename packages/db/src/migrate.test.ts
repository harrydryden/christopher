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

/** A migrations folder holding exactly these entries, each creating one probe table. */
async function writeProbeFolder(entries: JournalEntry[]) {
  await rm(folder, { recursive: true, force: true });
  await mkdir(join(folder, "meta"), { recursive: true });
  await writeFile(join(folder, "meta", "_journal.json"), JSON.stringify({
    version: "7", dialect: "postgresql", entries: entries.map(entry => ({ ...entry, version: "7", breakpoints: true })),
  }));
  for (const entry of entries) {
    await writeFile(join(folder, `${entry.tag}.sql`), `CREATE TABLE IF NOT EXISTS "migration_probe"."${entry.tag}" ("id" integer);`);
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
