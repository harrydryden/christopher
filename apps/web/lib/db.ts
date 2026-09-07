import { createDb } from "@christopher/db/client";
export type Db = ReturnType<typeof createDb>["db"];
let cached: Db | null = null;
/** Shared connection policy, with a small serverless pool. Direct subpath avoids migrations. */
export function db(): Db {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    cached = createDb(url, { max: 3 }).db;
  }
  return cached;
}
