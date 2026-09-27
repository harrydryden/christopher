/**
 * PostgreSQL's backends: the budget that runs out first.
 *
 * PgBouncer's client slots are plentiful (30,000 on Render); the database's backends are not. Render
 * allows 103, three reserved for superusers, and PgBouncer may open up to 93 of them for the
 * interface while the worker holds up to 26 on the direct port: 119 against 100 usable. When they
 * run out, a worker reconnect, a migration or an operator's `psql` fails with "sorry, too many
 * clients already" for every account at once. Clients report `application_name` (`ava-web`,
 * `ava-worker`), so the count can say who holds them. docs/DEPLOY.md gives the cap and the alert.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./client";

/** Client backends at which to alert: 80 % of the 100 usable on Render's plan (docs/DEPLOY.md). */
export const BACKENDS_ALERT_AT = 80;
/** The interface's share: `WEB_DB_POOL_MAX` × peak concurrent web instances stays at or under this. */
export const WEB_BACKENDS_CAP = 60;

export interface DatabaseBackends {
  /** Client backends connected now, idle ones and the one asking included: what `max_connections` bounds. */
  total: number;
  /** Of those, the ones running a statement or holding a transaction open. */
  active: number;
  /** `max_connections` less the reserved slots: what `total` must stay under. */
  usable: number;
  /** The same two counts per `application_name`; a client that sent none is `(none)`. */
  byApplication: Record<string, { total: number; active: number }>;
}

/**
 * Who holds the database's backends right now, from `pg_stat_activity`. Every database on the
 * server counts against `max_connections`, so none is filtered out. A role without
 * `pg_read_all_stats` sees other roles' sessions without their state, so they count towards
 * `total` and not `active`; on Render every client uses the one role, so the counts are whole.
 */
export async function databaseBackends(db: Db): Promise<DatabaseBackends> {
  const [rows, limits] = await Promise.all([
    db.execute<{ application: string; total: number; active: number }>(sql`
      select coalesce(nullif(application_name, ''), '(none)') as application, count(*)::int as total,
        (count(*) filter (where state <> 'idle'))::int as active
      from pg_stat_activity where backend_type = 'client backend' group by 1 order by 1`),
    db.execute<{ usable: number }>(sql`
      select current_setting('max_connections')::int - current_setting('superuser_reserved_connections')::int
        - coalesce(nullif(current_setting('reserved_connections', true), '')::int, 0) as usable`),
  ]);
  const byApplication: DatabaseBackends["byApplication"] = {};
  let total = 0, active = 0;
  for (const row of rows.rows) {
    byApplication[row.application] = { total: row.total, active: row.active };
    total += row.total;
    active += row.active;
  }
  return { total, active, usable: limits.rows[0]!.usable, byApplication };
}
