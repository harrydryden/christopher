/**
 * Test helper: a claimed account and a session row for it, so actions and routes that
 * authenticate through `getCurrentUser` see a real signed-in user.
 */
import { createUser, schema, type Db } from "@christopher/db";
import { eq } from "drizzle-orm";
import { createSessionCookieValue, DEFAULT_SESSION_TTL_SECONDS } from "@/lib/session";

export async function ensureTestUser(db: Db, email = "tester@example.com", role: "admin" | "member" = "admin") {
  const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (existing) return existing;
  const { user } = await createUser(db, { email, name: email.split("@")[0], role, emailVerified: true });
  return user;
}

/** Create (or reuse) the account, open a session for it and return the cookie value that names it. */
export async function signInTestUser(db: Db, secret: string, email = "tester@example.com", role: "admin" | "member" = "admin") {
  const user = await ensureTestUser(db, email, role);
  const expiresAt = new Date(Date.now() + DEFAULT_SESSION_TTL_SECONDS * 1000);
  const [session] = await db.insert(schema.sessions).values({ userId: user.id, expiresAt }).returning({ id: schema.sessions.id });
  const cookie = await createSessionCookieValue(secret, session!.id, expiresAt);
  return { user, sessionId: session!.id, cookie };
}
