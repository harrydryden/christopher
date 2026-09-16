/**
 * Sign-in throttling backed by the database, so every instance of the interface shares one view
 * of the attempts. Keys are `login:email:<address>`, `login:ip:<address>` and so on.
 */
import { and, eq, gt, sql } from "drizzle-orm";
import { loginAttempts } from "@christopher/db/schema";
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
  resetEmail: { max: 3, windowMs: 60 * 60 * 1000 },
  resetAddress: { max: 20, windowMs: 60 * 60 * 1000 },
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

export async function clearAttempts(key: string): Promise<void> {
  await db().delete(loginAttempts).where(eq(loginAttempts.key, key));
}
