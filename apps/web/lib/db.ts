import { getDb, type Db } from "@christopher/db";

/** Shared pool for the web app; kept small since serverless functions each hold one. */
export function db(): Db {
  return getDb({ max: 3 });
}
