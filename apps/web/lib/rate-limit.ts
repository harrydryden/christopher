/**
 * Sign-in throttling backed by the database, so every instance of the interface shares one view
 * of the attempts. Keys are `login:email:<address>`, `login:ip:<address>` and so on.
 */
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { loginAttempts } from "@ava/db/schema";
import { db } from "./db";

export interface RateLimit {
  max: number;
  windowMs: number;
}

export const LIMITS = {
  /** Failed password attempts per email address. */
  loginEmail: { max: 5, windowMs: 15 * 60 * 1000 },
  /** Failed password attempts per address, across every account. */
  loginAddress: { max: 30, windowMs: 15 * 60 * 1000 },
  signupAddress: { max: 10, windowMs: 60 * 60 * 1000 },
  /** Links mailed to one address, by any path: reset, confirmation, or a signed-in resend. */
  resetEmail: { max: 3, windowMs: 60 * 60 * 1000 },
  resetAddress: { max: 20, windowMs: 60 * 60 * 1000 },
  /**
   * Wrong current passwords per account on the password form. A stolen session must not become an
   * unthrottled password oracle, and each check is a full-cost scrypt.
   */
  passwordChange: { max: 5, windowMs: 15 * 60 * 1000 },
  /**
   * Opening a shared CV preview, counted per link and per caller. A reviewer reads a CV, reloads
   * it, and comes back to it; a crawler that found the link in a forwarded email does not. The
   * window is generous because the page is the whole point of the link — the limit is here so one
   * leaked token cannot be turned into a scraping endpoint, not to ration reading.
   */
  shareView: { max: 240, windowMs: 60 * 60 * 1000 },
  /** Notes left through one link, per link and per caller: enough for a thorough read-through. */
  shareComment: { max: 20, windowMs: 60 * 60 * 1000 },
} as const satisfies Record<string, RateLimit>;

export async function isRateLimited(key: string, limit: RateLimit, now: Date = new Date()): Promise<boolean> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.key, key), gt(loginAttempts.at, new Date(now.getTime() - limit.windowMs))));
  return (row?.n ?? 0) >= limit.max;
}

export async function recordAttempt(key: string, now: Date = new Date()): Promise<void> {
  await db().insert(loginAttempts).values({ key, at: now });
}

export interface RateLimitReservation {
  id: string;
  key: string;
}

/**
 * Atomically reserve capacity against keys that may have different policies. The returned row ids
 * let a caller release this request alone when it turns out not to be a countable failure.
 */
export async function reserveRateLimits(
  entries: Array<{ key: string; limit: RateLimit }>,
  now: Date = new Date(),
): Promise<RateLimitReservation[] | null> {
  const byKey = new Map<string, RateLimit>();
  for (const { key, limit } of entries) if (!byKey.has(key)) byKey.set(key, limit);
  const ordered = [...byKey].sort(([a], [b]) => a.localeCompare(b));
  if (!ordered.length) return [];
  return db().transaction(async tx => {
    // Stable ordering prevents deadlocks when a link and caller share overlapping limits.
    // Transaction locks also work when no attempt row exists yet.
    for (const [key] of ordered) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 731409))`);
    }
    for (const [key, limit] of ordered) {
      const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(loginAttempts)
        .where(and(eq(loginAttempts.key, key), gt(loginAttempts.at, new Date(now.getTime() - limit.windowMs))));
      if ((row?.n ?? 0) >= limit.max) return null;
    }
    return tx.insert(loginAttempts).values(ordered.map(([key]) => ({ key, at: now })))
      .returning({ id: loginAttempts.id, key: loginAttempts.key });
  });
}

/** Admit and count a public request atomically across every web instance. */
export async function consumeRateLimit(keys: string[], limit: RateLimit, now: Date = new Date()): Promise<boolean> {
  return (await reserveRateLimits(keys.map(key => ({ key, limit })), now)) !== null;
}

/** Release only rows reserved by this request, leaving concurrent failures untouched. */
export async function releaseRateLimitReservations(reservations: RateLimitReservation[]): Promise<void> {
  const ids = reservations.map(({ id }) => id);
  if (ids.length) await db().delete(loginAttempts).where(inArray(loginAttempts.id, ids));
}

export async function clearAttempts(key: string): Promise<void> {
  await db().delete(loginAttempts).where(eq(loginAttempts.key, key));
}
