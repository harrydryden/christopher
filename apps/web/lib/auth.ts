/**
 * Who is signed in. Server components, server actions and route handlers all authenticate here,
 * independently of middleware: the cookie names a session row, and the row decides.
 */
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, ne } from "drizzle-orm";
import { sessions, users, type User } from "@christopher/db/schema";
import { db } from "./db";
import { createSessionCookieValue, DEFAULT_SESSION_TTL_SECONDS, isSecureHost, readSessionCookie, SESSION_COOKIE_NAME } from "./session";

export interface CurrentUser {
  user: User;
  sessionId: string;
}

/** The signed-in account for this request, memoised per request. Null when nobody is signed in. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  const value = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const parsed = await readSessionCookie(value, secret);
  if (!parsed) return null;
  const [row] = await db()
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, parsed.sessionId), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!row || !row.user.claimedAt) return null;
  if (Date.now() - row.session.lastSeenAt.getTime() > 3_600_000) {
    void db().update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.session.id)).catch(() => undefined);
  }
  return { user: row.user, sessionId: row.session.id };
});

/** Server actions are callable endpoints and authenticate independently of middleware. */
export async function requireUser(): Promise<User> {
  const current = await getCurrentUser();
  if (!current) throw new Error("Unauthorised");
  return current.user;
}

/** Work that scans, discovers or calls a model waits for a confirmed address, so a throwaway sign-up cannot spend the shared budget. */
export async function requireVerifiedUser(): Promise<User> {
  const user = await requireUser();
  if (!user.emailVerifiedAt) redirect("/account?verify=required");
  return user;
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (user.role !== "admin") throw new Error("Forbidden");
  return user;
}

/** Older call sites only needed to know that a session exists. */
export async function requireSession(): Promise<User> {
  return requireUser();
}

export async function isAdmin(): Promise<boolean> {
  return (await getCurrentUser())?.user.role === "admin";
}

/** The caller's address for throttling, behind the platform's proxy. */
export async function clientAddress(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || h.get("x-real-ip") || "unknown";
}

/** Create a session row for `userId` and set the cookie that names it. */
export async function startSession(userId: string, ttlSeconds = DEFAULT_SESSION_TTL_SECONDS): Promise<string> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  const h = await headers();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const [session] = await db()
    .insert(sessions)
    .values({ userId, expiresAt, userAgent: h.get("user-agent")?.slice(0, 300) ?? null, ipAddress: (await clientAddress()).slice(0, 100) })
    .returning({ id: sessions.id });
  await db().update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  const value = await createSessionCookieValue(secret, session!.id, expiresAt);
  (await cookies()).set(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: isSecureHost(h.get("host")),
    maxAge: ttlSeconds,
  });
  return session!.id;
}

/** Delete the current session row and clear its cookie. */
export async function endSession(): Promise<void> {
  const current = await getCurrentUser().catch(() => null);
  if (current) await db().delete(sessions).where(eq(sessions.id, current.sessionId));
  (await cookies()).delete(SESSION_COOKIE_NAME);
}

/** Sign the account out of every other browser. */
export async function endOtherSessions(userId: string, keepSessionId: string): Promise<number> {
  const rows = await db().delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId))).returning({ id: sessions.id });
  return rows.length;
}

export async function endAllSessions(userId: string): Promise<void> {
  await db().delete(sessions).where(eq(sessions.userId, userId));
}
