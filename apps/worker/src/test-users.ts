/** Test helper: an account to act for, created once per email and reused across truncations. */
import { createUser, schema, type Db } from "@ava/db";
import { eq } from "drizzle-orm";

/** The one database every suite defaults to, so `pnpm -r test` needs one database and no more. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";

/**
 * The test database, with every connection opened from it named for `suite`. `pg_stat_activity`
 * and `pg_locks` see every session on the server, including a developer's worker or psql on the
 * same database; a suite that asks what is waiting or idle in a transaction asks about its own
 * sessions by this name, and nobody else's.
 */
export function testDatabaseUrl(suite: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.searchParams.set("application_name", suite);
  return url.toString();
}

export async function ensureTestUser(db: Db, email = "tester@example.com", role: "admin" | "member" = "admin") {
  const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (existing) return existing;
  const { user } = await createUser(db, { email, name: email.split("@")[0], role, emailVerified: true });
  return user;
}
