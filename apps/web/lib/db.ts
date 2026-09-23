import { createDb } from "@ava/db/client";
export type Db = ReturnType<typeof createDb>["db"];
let cached: Db | null = null;
/** Shared connection policy, with a small serverless pool. Direct subpath avoids migrations. */
export function db(): Db {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    // Three connections per instance, and statements bounded at 30 s: a request-serving process
    // must never hold a connection open across a hung query, and Render's pool is shared with the
    // worker. A transaction left idle for 30 s is closed for the same reason.
    cached = createDb(url, { max: 3, statementTimeoutMs: 30_000, idleInTransactionTimeoutMs: 30_000 }).db;
  }
  return cached;
}
