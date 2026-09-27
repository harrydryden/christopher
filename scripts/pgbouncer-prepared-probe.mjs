/**
 * Does the interface's database endpoint keep named prepared statements across transactions?
 *
 * The interface talks to Render's PgBouncer (port 6432) in transaction mode. A named statement
 * there works only when PgBouncer is 1.21 or later with `max_prepared_statements` above zero;
 * otherwise the second transaction to reach a server connection that never saw the Parse fails
 * with `prepared statement "…" does not exist`. The interface names none of its statements
 * (docs/PERFORMANCE-GUIDE.md 3.7) until this probe says it may.
 *
 * The probe opens a pool of two and runs `select 1` as the named statement `probe` twenty times,
 * each in its own transaction, so the pooler has every chance to hand a transaction a server
 * connection the statement was never parsed on. It reads nothing and writes nothing.
 *
 * usage: DATABASE_URL=<the interface's pooled URL> node scripts/pgbouncer-prepared-probe.mjs
 *
 * Exit codes:
 *   0  supported: all twenty executions succeeded.
 *   2  not supported: the endpoint lost the prepared statement (or refused to prepare one).
 *   1  the probe could not run: no DATABASE_URL, or a connection or other error.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const pg = require("pg");

/** PostgreSQL's code for a prepared statement the server does not have, and PgBouncer's wording. */
export function isPreparedStatementUnsupported(error) {
  const message = String(error?.message ?? "");
  return error?.code === "26000" || /prepared statement .* does not exist/i.test(message) || /prepared statement .* already exists/i.test(message)
    || /unsupported pkt type: 80|prepared statements? (are )?not supported/i.test(message);
}

export async function probe(connectionString, { runs = 20, poolSize = 2 } = {}) {
  const local = /^(localhost|127\.0\.0\.1|::1)$/.test(new URL(connectionString).hostname);
  const pool = new pg.Pool({ connectionString, max: poolSize, ssl: local ? undefined : { rejectUnauthorized: false } });
  try {
    for (let i = 0; i < runs; i++) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query({ name: "probe", text: "select 1 as one" });
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        client.release(true);
        if (isPreparedStatementUnsupported(error)) return { supported: false, run: i + 1, message: error.message };
        throw error;
      }
      client.release();
    }
    return { supported: true, runs };
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required: the interface's pooled URL.");
    process.exit(1);
  }
  try {
    const result = await probe(url);
    if (result.supported) {
      console.log(`supported: ${result.runs} executions of a named statement in separate transactions succeeded`);
      process.exit(0);
    }
    console.log(`not supported: execution ${result.run} failed with "${result.message}"`);
    process.exit(2);
  } catch (error) {
    console.error(`probe failed: ${error?.message ?? error}`);
    process.exit(1);
  }
}
