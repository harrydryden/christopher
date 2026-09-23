import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isRenderPooledUrl, logLine, type Db } from "./client";

const LOCK_KEY = 74_233_101; // arbitrary advisory lock id shared by all processes

/** One entry of `drizzle/meta/_journal.json`: what the migrator reads to decide what to apply. */
export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

export function readJournal(migrationsFolder: string): JournalEntry[] {
  const journal = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8")) as { entries: JournalEntry[] };
  return journal.entries;
}

/**
 * The migrator applies an entry only when its `when` is later than the newest one the database has
 * already applied, and says nothing about the entries it passes over. An entry that is not later
 * than the one before it is therefore skipped on every database that has the earlier one, while a
 * fresh database — every test run — applies it and stays green. Refuse such a journal outright.
 */
export function assertJournalOrdered(entries: readonly JournalEntry[]): void {
  for (let i = 1; i < entries.length; i++) {
    const previous = entries[i - 1]!;
    const entry = entries[i]!;
    if (entry.idx <= previous.idx) {
      throw new Error(`Migration ${entry.tag} has journal idx ${entry.idx}, which does not follow ${previous.tag}'s ${previous.idx}.`);
    }
    if (entry.when <= previous.when) {
      throw new Error(`Migration ${entry.tag} has journal "when" ${entry.when}, which is not later than ${previous.tag}'s ${previous.when}, `
        + `so the migrator would skip it on every database that already has ${previous.tag}. Give it a "when" greater than ${previous.when}; see packages/db/README.md.`);
    }
  }
}

/**
 * The tags of journal entries that no row of the migrations table records. Compared by `when`,
 * which is what the migrator stores as `created_at`, and not by hash: a file edited after it was
 * applied has still been applied.
 */
export function unappliedMigrations(entries: readonly JournalEntry[], appliedMillis: Iterable<number | string>): string[] {
  const applied = new Set(Array.from(appliedMillis, Number));
  return entries.filter(entry => !applied.has(entry.when)).map(entry => entry.tag);
}

export interface MigrationOptions {
  /** How long any one statement, the advisory lock included, may wait for a lock before the attempt is abandoned. */
  lockTimeout?: string;
  /** Attempts at the advisory lock, and then at the migrations, before giving up. */
  attempts?: number;
  /** What happens between attempts at migrations that lost a lock; `attempt` starts at 1. Defaults to a backoff of 1 s, doubling to 15 s. */
  retryWait?: (attempt: number) => Promise<void>;
  /** Tests only: another folder of migrations, and the table that records what was applied from it. */
  migrationsFolder?: string;
  migrationsTable?: string;
  migrationsSchema?: string;
}

const LOCK_NOT_AVAILABLE = "55P03";

/** Whether an error, or anything it wraps, is PostgreSQL giving up on a lock after `lock_timeout`. */
function lockNotAvailable(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    if ((current as { code?: unknown }).code === LOCK_NOT_AVAILABLE) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function retryingLockTimeouts<T>(attempts: number, wait: (attempt: number) => Promise<void>, what: string, work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!lockNotAvailable(error)) throw error;
      if (attempt >= attempts) {
        throw new Error(`Gave up on ${what} after ${attempts} attempts: each waited out lock_timeout behind another session's lock. `
          + "Find the blocking session in pg_stat_activity, or run the migrations again once it has finished.", { cause: error });
      }
      logLine("warn", "migration_lock_retry", { what, attempt, attempts });
      await wait(attempt);
    }
  }
}

const backoff = (attempt: number) => new Promise<void>(resolve => setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 15_000)));

export async function runMigrations(db: Db, options: MigrationOptions = {}) {
  // Render's managed PgBouncer endpoint uses transaction pooling. A session advisory lock
  // could be acquired and released on different backends there, so migrations must use the
  // direct endpoint. Check before opening a connection, without logging the credential URL.
  const connectionString = db.$client.options.connectionString;
  if (connectionString && isRenderPooledUrl(connectionString)) {
    throw new Error("Migrations require Render's direct database URL on port 5432, not its transaction-pooled URL on port 6432. Keep the worker and migration runner on the direct endpoint.");
  }
  const migrationsFolder = options.migrationsFolder ?? fileURLToPath(new URL("../drizzle", import.meta.url));
  const journal = readJournal(migrationsFolder);
  assertJournalOrdered(journal);
  const attempts = options.attempts ?? 6;
  const migrationsSchema = options.migrationsSchema ?? "drizzle";
  const migrationsTable = options.migrationsTable ?? "__drizzle_migrations";
  const client = await db.$client.connect();
  let locked = false;
  let failure: Error | undefined;
  try {
    // A migration that queues for an exclusive lock behind a long read blocks every later query on
    // that table for as long as it waits, which during a deploy is the interface. Waiting a bounded
    // time and trying again keeps that window short. The statement ceiling is generous because a
    // backfill or an index build legitimately runs longer than any request.
    await client.query("select set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)", [options.lockTimeout ?? "10s", "10min"]);
    // A second process booting at the same moment waits for the first, but not for ever.
    await retryingLockTimeouts(attempts, async () => {}, "the migration lock", () => client.query("select pg_advisory_lock($1)", [LOCK_KEY]));
    locked = true;
    // Every pending migration runs in one transaction, so a lock timeout rolls all of them back
    // and a retry starts from the same place.
    await retryingLockTimeouts(attempts, options.retryWait ?? backoff, "the migrations", () =>
      migrate(drizzle(client), { migrationsFolder, migrationsTable, migrationsSchema }));
    const recorded = await client.query<{ created_at: string }>(
      `select created_at from ${client.escapeIdentifier(migrationsSchema)}.${client.escapeIdentifier(migrationsTable)}`);
    const missing = unappliedMigrations(journal, recorded.rows.map(row => row.created_at));
    if (missing.length) {
      throw new Error(`Migration(s) ${missing.join(", ")} are in the journal but were not applied: their journal "when" is not later than the newest migration this database had already applied. `
        + "Give them a later \"when\" (see packages/db/README.md) and deploy again.");
    }
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
    await client.query("reset lock_timeout");
    await client.query("reset statement_timeout");
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    // The lock goes at once if the connection still works; the session ending below is the backstop.
    if (locked) await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    throw error;
  } finally {
    // A failed run ends its session instead of returning it to the pool: that releases the
    // advisory lock and the settings above even when the connection itself is what failed, and
    // never hands a broken client to the next query.
    client.release(failure);
  }
}
