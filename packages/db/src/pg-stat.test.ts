/**
 * Migration 0045's guarded extension and the reader behind `pnpm cli pgstat` and the Operations card.
 * Local and CI servers usually do not preload pg_stat_statements, so the reader's answer depends on
 * the server: rows when it is loaded, the reason when it is not. Both are asserted, whichever applies.
 *
 * Requires a database: set TEST_DATABASE_URL (defaults to the local ava_test database).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createDb } from "./client";
import { runMigrations } from "./migrate";
import { formatStatementTotals, resetStatements, topStatements } from "./pg-stat";

const { db, pool } = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test", { max: 1 });
beforeAll(() => runMigrations(db));
afterAll(() => pool.end());

const MIGRATION = readFileSync(fileURLToPath(new URL("../drizzle/0045_pg_stat_statements_web_vitals.sql", import.meta.url)), "utf8");
/** The guarded block alone, as the migrator runs it. */
const GUARDED = MIGRATION.split("--> statement-breakpoint")[0]!.replace(/^--.*$/gm, "").trim();

async function extensionAvailable(): Promise<boolean> {
  const rows = await db.execute(sql`select 1 from pg_available_extensions where name = 'pg_stat_statements'`);
  return rows.rows.length > 0;
}

async function preloaded(): Promise<boolean> {
  const rows = await db.execute<{ setting: string }>(sql`select setting from pg_settings where name = 'shared_preload_libraries'`);
  return (rows.rows[0]?.setting ?? "").split(",").map((s) => s.trim()).includes("pg_stat_statements");
}

describe("migration 0045's pg_stat_statements", () => {
  it("installs the extension for a role that may, wherever the server has it", async () => {
    if (!(await extensionAvailable())) return;
    const rows = await db.execute(sql`select 1 from pg_extension where extname = 'pg_stat_statements'`);
    expect(rows.rows).toHaveLength(1);
  });

  it("skips with a notice, not an error, for a role that may not create it", async () => {
    if (!(await extensionAvailable())) return;
    // Inside a transaction that is rolled back: the extension goes, an unprivileged role runs the
    // migration's block, and nothing of it survives the test.
    let ran = false;
    await db.transaction(async (tx) => {
      await tx.execute(sql`drop extension if exists pg_stat_statements`);
      await tx.execute(sql`create role ava_pgstat_unprivileged nologin`);
      await tx.execute(sql`grant usage, create on schema public to ava_pgstat_unprivileged`);
      await tx.execute(sql`set local role ava_pgstat_unprivileged`);
      await tx.execute(sql.raw(GUARDED));
      await tx.execute(sql`reset role`);
      const installed = await tx.execute(sql`select 1 from pg_extension where extname = 'pg_stat_statements'`);
      expect(installed.rows).toHaveLength(0);
      ran = true;
      tx.rollback();
    }).catch((error) => {
      if (!ran) throw error;
    });
    expect(ran).toBe(true);
    const still = await db.execute(sql`select 1 from pg_extension where extname = 'pg_stat_statements'`);
    expect(still.rows).toHaveLength(1);
  });
});

describe("topStatements", () => {
  it("reads this database's costliest statements when the server preloads the extension, and says why not otherwise", async () => {
    await db.execute(sql`select count(*) from pg_class where relname = ${"pg-stat-probe"}`);
    const totals = await topStatements(db);
    if (!(await extensionAvailable())) {
      expect(totals).toMatchObject({ available: false, reason: expect.stringMatching(/not installed/) });
      return;
    }
    if (await preloaded()) {
      expect(totals.available).toBe(true);
      if (!totals.available) return;
      expect(totals.rows.length).toBeGreaterThan(0);
      expect(totals.rows.length).toBeLessThanOrEqual(20);
      for (const row of totals.rows) {
        expect(row.query.length).toBeLessThanOrEqual(160);
        expect(row.query).not.toMatch(/\s{2,}|\n/);
        expect(row.calls).toBeGreaterThan(0);
      }
      // Ordered by total time, and normalised: the literal above is a parameter, not the text.
      for (let i = 1; i < totals.rows.length; i++) expect(totals.rows[i - 1]!.totalMs).toBeGreaterThanOrEqual(totals.rows[i]!.totalMs);
      expect(totals.rows.some((row) => row.query.includes("pg-stat-probe"))).toBe(false);
      expect(await resetStatements(db)).toEqual({ ok: true });
    } else {
      // Installed by the migration but not loaded: the graceful answer, not a thrown error.
      expect(totals).toEqual({ available: false, reason: expect.stringMatching(/shared_preload_libraries/) });
      expect(await resetStatements(db)).toEqual({ ok: false, reason: expect.stringMatching(/shared_preload_libraries/) });
    }
  });

  it("says the extension is not installed when a database lacks it, without throwing", async () => {
    if (!(await extensionAvailable())) return;
    let answer: Awaited<ReturnType<typeof topStatements>> | null = null;
    await db.transaction(async (tx) => {
      await tx.execute(sql`drop extension if exists pg_stat_statements`);
      answer = await topStatements(tx as never);
      tx.rollback();
    }).catch((error) => {
      if (!answer) throw error;
    });
    expect(answer).toEqual({ available: false, reason: expect.stringMatching(/not installed/) });
  });
});

describe("formatStatementTotals", () => {
  it("prints the guide's columns, figures aligned and the query last", () => {
    const lines = formatStatementTotals([
      { queryid: "1", calls: 1200, totalMs: 15000.4, meanMs: 12.5, stddevMs: 3.21, rows: 1200, sharedBlksHit: 99000, sharedBlksRead: 1000, hitPct: 99, query: "select * from user_jobs where user_id = $1" },
      { queryid: "2", calls: 3, totalMs: 1, meanMs: 0.33, stddevMs: 0, rows: 0, sharedBlksHit: 0, sharedBlksRead: 0, hitPct: null, query: "begin" },
    ]);
    expect(lines[0]).toBe("calls  total ms  mean ms  sd ms  rows    hit  read  hit %  query");
    expect(lines[1]).toBe(" 1200   15000.4    12.50   3.21  1200  99000  1000   99.0  select * from user_jobs where user_id = $1");
    expect(lines[2]).toBe("    3       1.0     0.33   0.00     0      0     0      –  begin");
  });
});
