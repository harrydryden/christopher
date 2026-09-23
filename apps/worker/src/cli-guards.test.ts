/**
 * The operational CLI's guards: it never migrates as a side effect, never runs against a schema
 * other than its own, and never turns a mistyped company into an action on the whole catalogue.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { compareSchema, discoverTargets, findCompany, readJournal, schemaState, type SchemaState } from "./cli-guards";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";
const WORKER_DIR = fileURLToPath(new URL("..", import.meta.url));

let db: Db;
let pool: { end(): Promise<void> };

beforeAll(async () => {
  ({ db, pool } = createDb(DATABASE_URL, { max: 2 }));
  await runMigrations(db);
}, 60_000);
afterAll(async () => { await pool?.end(); });
beforeEach(async () => { await db.execute(sql`truncate companies, tasks restart identity cascade`); });

function cli(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: WORKER_DIR,
    env: { ...process.env, DATABASE_URL, AVA_DISABLE_BROWSER: "1", NODE_ENV: "test" },
    encoding: "utf8",
    timeout: 60_000,
  });
}

async function taskCount() {
  const result = await db.execute<{ n: number }>(sql`select count(*)::int as n from tasks`);
  return result.rows[0]!.n;
}

/** Run `work` inside a transaction that is always rolled back, so the ledger is never left altered. */
async function inRolledBack(work: (tx: Db) => Promise<SchemaState>): Promise<SchemaState> {
  let seen: SchemaState | undefined;
  const rollback = new Error("rollback");
  await db.transaction(async tx => {
    seen = await work(tx as unknown as Db);
    throw rollback;
  }).catch(err => { if (err !== rollback) throw err; });
  return seen!;
}

describe("compareSchema", () => {
  const journal = [{ tag: "0001_a", when: 100 }, { tag: "0002_b", when: 200 }, { tag: "0003_c", when: 300 }];

  it("is current when the newest applied migration is the checkout's newest", () => {
    expect(compareSchema(journal, 300)).toEqual({ state: "current" });
  });

  it("lists exactly what the migrator would apply when the database is behind", () => {
    expect(compareSchema(journal, 100)).toEqual({ state: "behind", pending: ["0002_b", "0003_c"] });
    expect(compareSchema(journal, null)).toEqual({ state: "behind", pending: ["0001_a", "0002_b", "0003_c"] });
  });

  it("is ahead when the database was migrated by a newer release", () => {
    expect(compareSchema(journal, 400)).toEqual({ state: "ahead", appliedAt: 400, expectedAt: 300 });
  });
});

describe("schemaState against the database", () => {
  it("reads a migrated database as current, and a missing or newer ledger row as behind or ahead", async () => {
    const journal = readJournal();
    const newest = journal.at(-1)!;
    expect(await schemaState(db, journal)).toEqual({ state: "current" });

    expect(await inRolledBack(async tx => {
      await tx.execute(sql`delete from drizzle.__drizzle_migrations where created_at = ${newest.when}`);
      return schemaState(tx, journal);
    })).toEqual({ state: "behind", pending: [newest.tag] });

    expect(await inRolledBack(async tx => {
      await tx.execute(sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('from-a-newer-release', ${newest.when + 1})`);
      return schemaState(tx, journal);
    })).toEqual({ state: "ahead", appliedAt: newest.when + 1, expectedAt: newest.when });
  });
});

describe("discoverTargets", () => {
  beforeEach(async () => {
    await db.insert(schema.companies).values([
      { name: "Acme", homepageUrl: "https://acme.com/", domain: "acme.com" },
      { name: "Globex", homepageUrl: "https://globex.com/", domain: "globex.com" },
      { name: "Initech", homepageUrl: "https://initech.com/", domain: "initech.com", status: "archived" },
    ]);
  });

  it("refuses a company that matches nothing instead of falling back to the catalogue", async () => {
    await expect(discoverTargets(db, ["acme.cm", "https://boards.greenhouse.io/acme"])).rejects.toThrow("no company matching acme.cm");
    await expect(discoverTargets(db, ["acme.cm"])).rejects.toThrow("no company matching acme.cm");
  });

  it("needs --all to reach every active company, and never with a careers URL", async () => {
    await expect(discoverTargets(db, [])).rejects.toThrow(/usage: cli discover/);
    await expect(discoverTargets(db, ["--all", "https://boards.greenhouse.io/acme"])).rejects.toThrow(/belongs to one company/);
    await expect(discoverTargets(db, ["acme.com", "--all"])).rejects.toThrow(/usage: cli discover/);
    const all = await discoverTargets(db, ["--all"]);
    expect(all.companies.map(c => c.name).sort()).toEqual(["Acme", "Globex"]);
    expect(all.url).toBeUndefined();
  });

  it("finds one company by domain, URL, name or id, with the URL for that one only", async () => {
    const byDomain = await discoverTargets(db, ["acme.com", "https://boards.greenhouse.io/acme"]);
    expect(byDomain.companies.map(c => c.name)).toEqual(["Acme"]);
    expect(byDomain.url).toBe("https://boards.greenhouse.io/acme");
    expect((await findCompany(db, "https://www.acme.com/careers")).name).toBe("Acme");
    expect((await findCompany(db, "GLOBEX")).name).toBe("Globex");
    const acme = await findCompany(db, "acme.com");
    expect((await findCompany(db, acme.id.toUpperCase())).name).toBe("Acme");
  });

  it("refuses a needle that matches more than one company", async () => {
    await db.insert(schema.companies).values({ name: "acme.com", homepageUrl: "https://acme-other.com/", domain: "acme-other.com" });
    await expect(findCompany(db, "acme.com")).rejects.toThrow(/2 companies match acme\.com/);
  });
});

describe("the CLI process", () => {
  it("exits with an error and queues nothing when discover is given a mistyped company", async () => {
    await db.insert(schema.companies).values([
      { name: "Acme", homepageUrl: "https://acme.com/", domain: "acme.com" },
      { name: "Globex", homepageUrl: "https://globex.com/", domain: "globex.com" },
    ]);
    const run = cli("discover", "acme.cm", "https://boards.greenhouse.io/acme");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("no company matching acme.cm");
    expect(await taskCount()).toBe(0);

    const one = cli("discover", "acme.com");
    expect(one.status).toBe(0);
    expect(one.stdout).toContain("queued discovery for Acme");
    expect(await taskCount()).toBe(1);
  });

  it("refuses to run a read-only command against a database behind this checkout, and applies nothing", async () => {
    const newest = readJournal().at(-1)!;
    const [row] = (await db.execute<{ hash: string }>(sql`delete from drizzle.__drizzle_migrations where created_at = ${newest.when} returning hash`)).rows;
    expect(row).toBeTruthy();
    try {
      const run = cli("users");
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`The database is behind this checkout: 1 migration(s) not applied (${newest.tag})`);
      const ledger = await db.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations where created_at = ${newest.when}`);
      expect(ledger.rows[0]!.n).toBe(0);
    } finally {
      await db.execute(sql`insert into drizzle.__drizzle_migrations (hash, created_at)
        select ${row!.hash}, ${newest.when} where not exists (select 1 from drizzle.__drizzle_migrations where created_at = ${newest.when})`);
    }
    expect(await schemaState(db)).toEqual({ state: "current" });
    const users = cli("users");
    expect(users.status).toBe(0);
    expect(users.stdout).toMatch(/account\(s\)/);
  });
});
