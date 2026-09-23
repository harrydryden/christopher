/** Test helper: an account to act for, created once per email and reused across truncations. */
import { createUser, schema, type Db } from "@ava/db";
import { eq } from "drizzle-orm";

export async function ensureTestUser(db: Db, email = "tester@example.com", role: "admin" | "member" = "admin") {
  const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (existing) return existing;
  const { user } = await createUser(db, { email, name: email.split("@")[0], role, emailVerified: true });
  return user;
}
