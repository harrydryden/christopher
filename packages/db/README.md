# @ava/db

The Drizzle schema (`src/schema.ts`), the migrations (`drizzle/`), the pool (`src/client.ts`) and
the helpers every other package shares. `src/migrate.ts` applies the migrations; the worker runs it
at boot and `pnpm db:migrate` runs it by hand.

## Migrations are written by hand

`drizzle-kit generate` is not used. Its snapshots in `drizzle/meta` stop at 0020, so it would diff
the schema against a month-old picture and emit every table added since; and it stamps the new
entry with the current time, which the next rule makes fatal. Write the SQL yourself:

1. Add `drizzle/<idx>_<name>.sql`. Separate statements with `--> statement-breakpoint`. Prefer
   `IF NOT EXISTS` / `IF EXISTS`, so a statement an operator has already run by hand is a no-op.
2. Append an entry to `drizzle/meta/_journal.json` with the next `idx`, `"version": "7"`,
   `"breakpoints": true`, the file's name as `tag`, and a `when` **greater than the last entry's**.
   The convention is the previous entry's `when` plus one day (86,400,000).
3. Mirror every table, column and index in `src/schema.ts`, which stays the source of truth.

### Why `when` must keep increasing

The migrator reads only the newest row of `drizzle.__drizzle_migrations` and applies an entry only
when its `when` is later than that row's. An entry that is not later is passed over without a word
on every database that already has the one before it, while a fresh database (every test run)
applies it and stays green. The journal's `when` values have been set by hand, a day apart, since
0022, and they run ahead of the calendar: a timestamp taken from today's clock is already too early.

Two things now catch the mistake. `src/migration-journal.test.ts` fails when an entry's `when` is
not strictly later than the one before it, or when a SQL file and the journal disagree. And
`runMigrations` refuses such a journal before connecting, and after migrating checks that every
journal entry is recorded as applied, so a skip stops the worker's boot instead of surfacing later
as a missing column.

Parallel branches each take their own `idx` and `when`. A gap in `idx` is allowed; the entries are
interleaved in order when the branches merge.

### Locks and time limits

`runMigrations` holds a session advisory lock, so two processes never migrate at once; that is why
it refuses Render's transaction-pooled URL. Its session waits at most `lock_timeout` (10 s) for any
lock: for the advisory lock, so a second booting process gives up after six attempts instead of
hanging; and for the tables it alters, so an `ALTER TABLE` queued behind a long read does not block
every later query on that table while it waits. A migration that loses a lock is rolled back and
tried again, up to six times with a growing pause. Its statements may run for ten minutes, for a
backfill or an index build. Both settings are reset before the connection goes back to the pool.

Every pending migration runs in one transaction, so `CREATE INDEX CONCURRENTLY` cannot be used in a
migration file. A plain `CREATE INDEX` blocks writes to its table while it builds. For a table large
enough for that to matter, build the index by hand first with `CONCURRENTLY` and the same name,
after `set statement_timeout = 0` in that session; the migration's `IF NOT EXISTS` then does nothing.
