/**
 * Who is signed in. Server components, server actions and route handlers all authenticate here,
 * independently of middleware: the cookie names a session row, and the row decides.
 */
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { and, eq, gt, ne } from "drizzle-orm";
import { authAccounts, sessions, users, type User } from "@col/db/schema";
import { db } from "./db";
import {
  createSessionCookieValue, DEFAULT_SESSION_TTL_SECONDS, isSecureHost, LEGACY_SESSION_COOKIE_NAMES, readSessionCookie,
  SESSION_COOKIE_NAME, sessionCookieValue, sessionSecret,
} from "./session";

export interface CurrentUser {
  user: User;
  sessionId: string;
}

/** The signed-in account for this request, memoised per request. Null when nobody is signed in. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const secret = sessionSecret();
  if (!secret) return null;
  const value = sessionCookieValue(await cookies());
  const parsed = await readSessionCookie(value, secret);
  if (!parsed) return null;
  const [row] = await db()
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, parsed.sessionId), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!row || !row.user.claimedAt) return null;
  if (Date.now() - row.session.lastSeenAt.getTime() > 3_600_000) touchSession(row.session.id);
  return { user: row.user, sessionId: row.session.id };
});

/**
 * Record that a session was used, at most hourly, without making the request wait for it. The
 * write goes through `after()`, Next's hook onto the platform's `waitUntil`: fired and forgotten
 * instead, it could be frozen with the instance once the response was sent, and lost or finished
 * on the next thaw. Outside a request (a script, a test) there is no platform to wait for, so it
 * simply runs.
 */
function touchSession(sessionId: string): void {
  const touch = () => db().update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, sessionId)).then(() => undefined, () => undefined);
  try {
    after(touch);
  } catch {
    void touch();
  }
}

/** Server actions are callable endpoints and authenticate independently of middleware. */
export async function requireUser(): Promise<User> {
  const current = await getCurrentUser();
  if (!current) throw new Error("Unauthorised");
  return current.user;
}

/**
 * Whether work that scans, discovers or calls a model is held back until this account confirms its
 * address, so a throwaway sign-up cannot spend the deployment's money. Administrators are never
 * held back: nobody becomes one without an address an administrator vouched for, either by proving
 * their own or by promoting someone from Admin.
 *
 * The one place that decides this. The pages that explain the gate ask here too, so a stale link
 * cannot tell someone their work is blocked when it is not.
 */
export function needsEmailConfirmation(user: Pick<User, "role" | "emailVerifiedAt">): boolean {
  return user.role !== "admin" && !user.emailVerifiedAt;
}

export async function requireVerifiedUser(): Promise<User> {
  const user = await requireUser();
  if (needsEmailConfirmation(user)) redirect("/account?verify=required");
  return user;
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (user.role !== "admin") throw new Error("Forbidden");
  return user;
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

async function setSessionCookie(secret: string, sessionId: string, expiresAt: Date, ttlSeconds: number, host: string | null): Promise<void> {
  const value = await createSessionCookieValue(secret, sessionId, expiresAt);
  (await cookies()).set(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: isSecureHost(host),
    maxAge: ttlSeconds,
  });
}

export type SessionProof =
  | { provider: "password"; expectedPasswordHash: string }
  | { provider: "google" | "linkedin"; subject: string };

/** A stale password or removed provider link cannot issue a fresh session after its revocation. */
export async function startSessionFromProof(input: { userId: string; proof: SessionProof; ttlSeconds?: number }): Promise<string | null> {
  const secret = sessionSecret();
  if (!secret) throw new Error("SESSION_SECRET is not set");
  const h = await headers();
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const ipAddress = (await clientAddress()).slice(0, 100);
  const sessionId = await db().transaction(async tx => {
    const [user] = await tx.select({ id: users.id, claimedAt: users.claimedAt, passwordHash: users.passwordHash })
      .from(users).where(eq(users.id, input.userId)).for("update");
    if (!user?.claimedAt) return null;
    if (input.proof.provider === "password") {
      if (!user.passwordHash || user.passwordHash !== input.proof.expectedPasswordHash) return null;
    } else {
      const [linked] = await tx.select({ id: authAccounts.id }).from(authAccounts)
        .where(and(eq(authAccounts.userId, user.id), eq(authAccounts.provider, input.proof.provider),
          eq(authAccounts.providerAccountId, input.proof.subject))).limit(1);
      if (!linked) return null;
    }
    const [session] = await tx.insert(sessions).values({ userId: user.id, expiresAt, authProvider: input.proof.provider,
      userAgent: h.get("user-agent")?.slice(0, 300) ?? null, ipAddress }).returning({ id: sessions.id });
    await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    return session?.id ?? null;
  });
  if (!sessionId) return null;
  await setSessionCookie(secret, sessionId, expiresAt, ttlSeconds, h.get("host"));
  return sessionId;
}

/** Delete the current session row and clear its cookie, under the current name and every legacy one. */
export async function endSession(): Promise<void> {
  const current = await getCurrentUser().catch(() => null);
  if (current) await db().delete(sessions).where(eq(sessions.id, current.sessionId));
  const jar = await cookies();
  jar.delete(SESSION_COOKIE_NAME);
  for (const name of LEGACY_SESSION_COOKIE_NAMES) jar.delete(name);
}

/** Sign the account out of every other browser. */
export async function endOtherSessions(userId: string, keepSessionId: string): Promise<number> {
  const rows = await db().delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId))).returning({ id: sessions.id });
  return rows.length;
}
