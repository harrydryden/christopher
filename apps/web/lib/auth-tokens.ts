/** Single-use links: only a hash of the token is stored, and it is consumed inside one transaction. */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { authTokens, type AuthToken } from "@ava/db/schema";
import { db } from "./db";

export type TokenPurpose = AuthToken["purpose"];

export const TOKEN_TTL_MS: Record<TokenPurpose, number> = {
  password_reset: 60 * 60 * 1000,
  email_verification: 24 * 60 * 60 * 1000,
};

/** sha256, hex. Exported so the share links hash their tokens the one way this product hashes a token. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Issue a fresh token for `userId`, invalidating earlier unused ones for the same purpose. */
export async function issueAuthToken(userId: string, purpose: TokenPurpose, now: Date = new Date()): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await db().transaction(async (tx) => {
    await tx.update(authTokens).set({ usedAt: now }).where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt)));
    await tx.insert(authTokens).values({ userId, purpose, tokenHash: hashToken(raw), expiresAt: new Date(now.getTime() + TOKEN_TTL_MS[purpose]) });
  });
  return raw;
}

/** The account a live token belongs to, without spending it. */
export async function peekAuthToken(raw: string, purpose: TokenPurpose, now: Date = new Date()): Promise<{ userId: string } | null> {
  if (!raw || raw.length > 200) return null;
  const [row] = await db()
    .select({ userId: authTokens.userId })
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, hashToken(raw)), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

/** Mark the token used and return its account, or null when it is unknown, spent or expired. */
export async function consumeAuthToken(raw: string, purpose: TokenPurpose, now: Date = new Date()): Promise<{ userId: string } | null> {
  if (!raw || raw.length > 200) return null;
  const tokenHash = hashToken(raw);
  return db().transaction(async (tx) => {
    const [row] = await tx
      .select({ id: authTokens.id, userId: authTokens.userId })
      .from(authTokens)
      .where(and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now)))
      .for("update");
    if (!row) return null;
    await tx.update(authTokens).set({ usedAt: sql`now()` }).where(eq(authTokens.id, row.id));
    return { userId: row.userId };
  });
}
