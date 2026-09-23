/**
 * The checks the operational CLI makes before it acts. It is run by hand from a checkout, often
 * against the production database, so two mistakes have to be impossible rather than unlikely:
 * applying a branch's unreleased migrations as a side effect of looking at something, and turning a
 * mistyped company into an action on the whole catalogue.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { schema, type Db } from "@ava/db";
import { extractDomain } from "@ava/core";
import { asc, eq, or, sql, type SQL } from "drizzle-orm";

export interface JournalEntry {
  tag: string;
  when: number;
}

export type SchemaState =
  | { state: "current" }
  | { state: "behind"; pending: string[] }
  | { state: "ahead"; appliedAt: number; expectedAt: number };

type Executor = Pick<Db, "execute">;

/** The migrations this checkout ships, from the same folder `runMigrations` applies. */
export function readJournal(): JournalEntry[] {
  const folder = join(dirname(createRequire(import.meta.url).resolve("@ava/db/migrate")), "..", "drizzle");
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as { entries: JournalEntry[] };
  return journal.entries.map(({ tag, when }) => ({ tag, when }));
}

/**
 * What `migrate` would do to a database whose newest recorded migration has `appliedAt`. The
 * migrator applies exactly the journal entries newer than that one, so those are what is pending;
 * a database whose newest entry is newer than anything here was migrated by a later release.
 */
export function compareSchema(journal: JournalEntry[], appliedAt: number | null): SchemaState {
  const pending = journal.filter(entry => appliedAt === null || entry.when > appliedAt).map(entry => entry.tag);
  if (pending.length) return { state: "behind", pending };
  const expectedAt = Math.max(...journal.map(entry => entry.when));
  if (appliedAt !== null && appliedAt > expectedAt) return { state: "ahead", appliedAt, expectedAt };
  return { state: "current" };
}

/** Reads the migration ledger without creating it: a database nobody has migrated is simply behind. */
export async function schemaState(db: Executor, journal: JournalEntry[] = readJournal()): Promise<SchemaState> {
  const ledger = await db.execute<{ present: boolean }>(sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`);
  if (!ledger.rows[0]?.present) return compareSchema(journal, null);
  const newest = await db.execute<{ applied_at: string | null }>(sql`select max(created_at)::text as applied_at from drizzle.__drizzle_migrations`);
  const appliedAt = newest.rows[0]?.applied_at;
  return compareSchema(journal, appliedAt == null ? null : Number(appliedAt));
}

/** Every command but `migrate` runs only against a database at exactly this checkout's schema. */
export async function assertSchemaCurrent(db: Executor, journal: JournalEntry[] = readJournal()): Promise<void> {
  const status = await schemaState(db, journal);
  if (status.state === "behind") {
    throw new Error(
      `The database is behind this checkout: ${status.pending.length} migration(s) not applied (${status.pending.join(", ")}). ` +
        "Nothing was changed. If this checkout is the release being deployed, apply them with `pnpm cli migrate` " +
        "in the order docs/DEPLOY.md gives; otherwise check out the deployed commit.",
    );
  }
  if (status.state === "ahead") {
    throw new Error(
      `The database was migrated by a newer release than this checkout (newest applied migration ${status.appliedAt}, ` +
        `newest here ${status.expectedAt}). Nothing was changed. Check out the deployed commit and run this again.`,
    );
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Companies an operator could mean by `needle`: its id, its domain (or a URL on it), or its exact name. */
export async function findCompanies(db: Db, needle: string) {
  const value = needle.trim();
  if (!value) return [];
  const lowered = value.toLowerCase();
  const conditions: SQL[] = [eq(schema.companies.domain, lowered), sql`lower(${schema.companies.name}) = ${lowered}`];
  if (value.includes(".")) conditions.push(eq(schema.companies.domain, extractDomain(value)));
  if (UUID.test(value)) conditions.push(eq(schema.companies.id, value.toLowerCase()));
  return db.select().from(schema.companies).where(or(...conditions)).orderBy(asc(schema.companies.name));
}

/** Exactly one company, or an error that says why not. Never a fallback to more than one. */
export async function findCompany(db: Db, needle: string) {
  const rows = await findCompanies(db, needle);
  if (rows.length === 0) throw new Error(`no company matching ${needle}`);
  if (rows.length > 1) throw new Error(`${rows.length} companies match ${needle} (${rows.map(c => `${c.name} ${c.id}`).join(", ")}); name one by its id`);
  return rows[0]!;
}

export const DISCOVER_USAGE = "usage: cli discover <company-id|domain|name> [careers-url] | cli discover --all";

/**
 * Which companies `discover` acts on. A careers URL is applied as that company's source, so it may
 * only accompany a single named company; the whole active catalogue is reached only by `--all`.
 */
export async function discoverTargets(db: Db, args: string[]) {
  const [needle, url, ...extra] = args;
  if (!needle || extra.length) throw new Error(DISCOVER_USAGE);
  if (needle === "--all") {
    if (url !== undefined) throw new Error("a careers URL belongs to one company: name that company instead of --all");
    return { companies: await db.select().from(schema.companies).where(eq(schema.companies.status, "active")), url: undefined };
  }
  if (url === "--all") throw new Error(DISCOVER_USAGE);
  return { companies: [await findCompany(db, needle)], url };
}
