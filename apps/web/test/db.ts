/**
 * Test helper: the one database every interface suite uses, and a pool the size production gives
 * the interface.
 *
 * `lib/db.ts` opens three connections per serverless instance on the direct endpoint (six through
 * PgBouncer). A suite on a larger pool passes where production deadlocks: a transaction that asks
 * the pool for a second connection finds one spare here and waits out the connection timeout there.
 * So every suite gets the narrower three, and a test that hangs on them has found a request that
 * needs more than production has.
 */
import { createDb, type CreateDbOptions } from "@ava/db";

/** The default is shared with every worker and database suite, so `pnpm -r test` needs one database. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";

/** The interface's production pool size. */
export const INTERFACE_POOL_SIZE = 3;

export function createTestDb(options: CreateDbOptions = {}) {
  return createDb(TEST_DATABASE_URL, { max: INTERFACE_POOL_SIZE, ...options });
}
