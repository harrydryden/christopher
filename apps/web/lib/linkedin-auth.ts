/** Account-owned, browser-bound LinkedIn sign-in state. No provider access token is retained. */
import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { authAccounts, linkedinAuthTransactions, sessions, users, type User } from "@col/db/schema";
import { ensureFreeEntitlement, isEntitledEmail, normaliseEmail, seedTagVocabulary, type Db } from "@col/db";
import { emailProblem, registrationAllowed } from "./accounts";
import { equalHash, sha256, type LinkedInIdentity } from "./linkedin";
import { sanitizeNextPath } from "./session";

export const LINKEDIN_COOKIE = "col_linkedin_pending";
export const LINKEDIN_FLOW_MS = 10 * 60_000;
export const LINKEDIN_PENDING_MS = 60 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function random(): string { return randomBytes(32).toString("base64url"); }

export function parseLinkedInCookie(value: string | undefined): { id: string; secret: string } | null {
  if (!value) return null;
  const index = value.indexOf(".");
  const id = value.slice(0, index);
  const secret = value.slice(index + 1);
  return index > 0 && UUID_RE.test(id) && /^[A-Za-z0-9_-]{40,80}$/.test(secret) ? { id, secret } : null;
}

export async function startLinkedInTransaction(database: Db, input: {
  intent: "sign_in" | "link"; next: string; initiatingUserId?: string; initiatingSessionId?: string; now?: Date;
}) {
  const now = input.now ?? new Date();
  if (input.intent === "link" && (!input.initiatingUserId || !input.initiatingSessionId)) throw new Error("Sign in before linking an account.");
  const state = random();
  const nonce = random();
  const secret = random();
  const [row] = await database.insert(linkedinAuthTransactions).values({
    stateHash: sha256(state), nonceHash: sha256(nonce), browserHash: sha256(secret),
    intent: input.intent, initiatingUserId: input.initiatingUserId ?? null,
    initiatingSessionId: input.initiatingSessionId ?? null,
    nextPath: sanitizeNextPath(input.next), expiresAt: new Date(now.getTime() + LINKEDIN_FLOW_MS),
  }).returning({ id: linkedinAuthTransactions.id });
  return { state, nonce, cookie: `${row!.id}.${secret}` };
}

async function lockedPending(database: Db, cookie: string | undefined, now = new Date()) {
  const parsed = parseLinkedInCookie(cookie);
  if (!parsed) return null;
  const [row] = await database.select().from(linkedinAuthTransactions)
    .where(and(eq(linkedinAuthTransactions.id, parsed.id), gt(linkedinAuthTransactions.expiresAt, now)))
    .for("update").limit(1);
  return row && equalHash(row.browserHash, sha256(parsed.secret)) ? row : null;
}

/** Consume the OAuth callback before any network exchange; a replay never sends another token request. */
export async function claimLinkedInCallback(database: Db, input: { cookie?: string; state?: string; now?: Date }) {
  const now = input.now ?? new Date();
  if (!input.state || input.state.length > 200) return null;
  return database.transaction(async tx => {
    const row = await lockedPending(tx as unknown as Db, input.cookie, now);
    if (!row || row.callbackUsedAt || !equalHash(row.stateHash, sha256(input.state!))) return null;
    await tx.update(linkedinAuthTransactions).set({ callbackUsedAt: now, expiresAt: new Date(now.getTime() + LINKEDIN_PENDING_MS) })
      .where(eq(linkedinAuthTransactions.id, row.id));
    return row;
  });
}

export type LinkedInSettlement =
  | { kind: "signed_in"; user: User; next: string }
  | { kind: "link_required" | "verify_email" | "create_account" | "recovery_required" };

function cleared() {
  return { browserHash: sha256(random()), subject: null, providerEmail: null, chosenEmail: null, emailTokenHash: null, appEmailVerifiedAt: null, name: null, completedAt: new Date() };
}

/** Record only validated ID-token claims. Existing email is never an account-linking credential. */
export async function settleLinkedInIdentity(database: Db, cookie: string | undefined, identity: LinkedInIdentity, now = new Date()): Promise<LinkedInSettlement> {
  const parsed = parseLinkedInCookie(cookie);
  if (!parsed) throw new Error("LinkedIn sign-in expired");
  const [row] = await database.select().from(linkedinAuthTransactions).where(eq(linkedinAuthTransactions.id, parsed.id)).limit(1);
  if (!row || !equalHash(row.browserHash, sha256(parsed.secret)) || !row.callbackUsedAt || row.verifiedAt || row.completedAt || row.expiresAt <= now) throw new Error("LinkedIn sign-in expired");
  const [linked] = await database.select({ user: users }).from(authAccounts).innerJoin(users, eq(users.id, authAccounts.userId))
    .where(and(eq(authAccounts.provider, "linkedin"), eq(authAccounts.providerAccountId, identity.sub))).limit(1);
  if (linked) {
    if (row.intent === "link" && row.initiatingUserId !== linked.user.id) throw new Error("That LinkedIn account is linked elsewhere");
    await database.update(linkedinAuthTransactions).set(cleared()).where(and(eq(linkedinAuthTransactions.id, row.id), isNull(linkedinAuthTransactions.completedAt)));
    return { kind: "signed_in", user: linked.user, next: row.nextPath };
  }

  const email = identity.email ? normaliseEmail(identity.email) : null;
  const usableVerifiedEmail = !!(identity.emailVerified && email && !emailProblem(email));
  const [sameEmail] = usableVerifiedEmail ? await database.select({ id: users.id }).from(users).where(eq(users.email, email!)).limit(1) : [];
  let kind: "link_required" | "verify_email" | "create_account" | "recovery_required";
  let targetUserId = row.initiatingUserId ?? sameEmail?.id ?? null;
  if (row.intent === "link" || sameEmail) kind = "link_required";
  else if (usableVerifiedEmail && isEntitledEmail(email!)) kind = "recovery_required";
  else if (usableVerifiedEmail && await registrationAllowed(email!)) kind = "create_account";
  else if (usableVerifiedEmail) kind = "recovery_required";
  else kind = "verify_email";
  await database.update(linkedinAuthTransactions).set({ subject: identity.sub, providerEmail: email, providerEmailVerified: usableVerifiedEmail, name: identity.name,
    targetUserId, pendingKind: kind, verifiedAt: now, expiresAt: new Date(now.getTime() + LINKEDIN_PENDING_MS) })
    .where(and(eq(linkedinAuthTransactions.id, row.id), isNull(linkedinAuthTransactions.verifiedAt)));
  return { kind };
}

export async function readLinkedInPending(database: Db, cookie: string | undefined, now = new Date()) {
  const parsed = parseLinkedInCookie(cookie);
  if (!parsed) return null;
  const [row] = await database.select().from(linkedinAuthTransactions)
    .where(and(eq(linkedinAuthTransactions.id, parsed.id), gt(linkedinAuthTransactions.expiresAt, now))).limit(1);
  return row && equalHash(row.browserHash, sha256(parsed.secret)) && row.verifiedAt && !row.completedAt ? row : null;
}

/** A provider subject is linked only after a fresh, verified, account-owned reauthentication. */
export async function completeLinkedInLinkIn(database: Db, input: { cookie?: string; userId: string; sessionId: string; passwordProven: boolean; now?: Date }) {
  const now = input.now ?? new Date();
  return database.transaction(async tx => {
    // Match createUser/subject-claim order: global identity fence before a pending or user row lock.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ava:users'))`);
    const pending = await lockedPending(tx as unknown as Db, input.cookie, now);
    if (!pending || !["link_required", "create_account", "verify_email", "recovery_required"].includes(pending.pendingKind ?? "") || !pending.subject || !pending.verifiedAt || pending.completedAt) throw new Error("LinkedIn link expired");
    if (pending.targetUserId && pending.targetUserId !== input.userId) throw new Error("Sign in to the intended account first");
    const [session] = await tx.select().from(sessions).where(and(eq(sessions.id, input.sessionId), eq(sessions.userId, input.userId), gt(sessions.expiresAt, now))).limit(1);
    const [user] = await tx.select().from(users).where(eq(users.id, input.userId)).for("update").limit(1);
    if (!session || !user || !user.claimedAt || !user.emailVerifiedAt) throw new Error("Verify the account email before linking LinkedIn");
    if (!input.passwordProven && ((session.authProvider !== "google" && session.authProvider !== "password") || session.id === pending.initiatingSessionId || session.createdAt.getTime() <= pending.verifiedAt.getTime() || now.getTime() - session.createdAt.getTime() > LINKEDIN_FLOW_MS)) throw new Error("Sign in again with the existing account before linking LinkedIn");
    const [existing] = await tx.select().from(authAccounts)
      .where(and(eq(authAccounts.provider, "linkedin"), eq(authAccounts.providerAccountId, pending.subject))).limit(1);
    if (existing && existing.userId !== input.userId) throw new Error("That LinkedIn account is linked elsewhere");
    if (!existing) await tx.insert(authAccounts).values({ userId: input.userId, provider: "linkedin", providerAccountId: pending.subject, email: pending.providerEmail, name: pending.name });
    await tx.update(linkedinAuthTransactions).set(cleared()).where(eq(linkedinAuthTransactions.id, pending.id));
    return { userId: input.userId, next: pending.nextPath };
  });
}

/** Email proof is bound to the same browser. Asking for a different address invalidates the old token. */
export async function beginLinkedInEmailProofIn(database: Db, input: { cookie?: string; email: string; now?: Date }) {
  const now = input.now ?? new Date();
  const email = normaliseEmail(input.email);
  if (emailProblem(email)) throw new Error("Enter a valid email address.");
  const token = random();
  const row = await database.transaction(async tx => {
    const pending = await lockedPending(tx as unknown as Db, input.cookie, now);
    if (!pending || pending.pendingKind !== "verify_email" || !pending.subject || pending.completedAt) throw new Error("LinkedIn sign-in expired");
    await tx.update(linkedinAuthTransactions).set({ chosenEmail: email, emailTokenHash: sha256(token), expiresAt: new Date(now.getTime() + LINKEDIN_PENDING_MS) })
      .where(eq(linkedinAuthTransactions.id, pending.id));
    return pending.id;
  });
  return { token, email, transactionId: row };
}

/** A GET may preview the proof; only this explicit POST consumes its one-use token. */
export async function completeLinkedInEmailProofIn(database: Db, input: { cookie?: string; token: string; now?: Date }) {
  const now = input.now ?? new Date();
  if (!input.token || input.token.length > 200) throw new Error("That verification link is not valid.");
  return database.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ava:users'))`);
    const pending = await lockedPending(tx as unknown as Db, input.cookie, now);
    if (!pending || pending.pendingKind !== "verify_email" || !pending.subject || !pending.chosenEmail || !pending.emailTokenHash || pending.completedAt || !equalHash(pending.emailTokenHash, sha256(input.token))) throw new Error("That verification link is not valid.");
    const email = pending.chosenEmail;
    // Consume proof even when the address belongs to an account. It never acts as a link credential.
    await tx.update(linkedinAuthTransactions).set({ emailTokenHash: null }).where(eq(linkedinAuthTransactions.id, pending.id));
    const [existingEmail] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    const [existingSubject] = await tx.select({ userId: authAccounts.userId }).from(authAccounts)
      .where(and(eq(authAccounts.provider, "linkedin"), eq(authAccounts.providerAccountId, pending.subject))).limit(1);
    if (existingSubject) throw new Error("That LinkedIn account is linked elsewhere");
    if (existingEmail) {
      await tx.update(linkedinAuthTransactions).set({ pendingKind: "link_required", targetUserId: existingEmail.id, chosenEmail: null,
        expiresAt: new Date(now.getTime() + LINKEDIN_PENDING_MS) }).where(eq(linkedinAuthTransactions.id, pending.id));
      return { kind: "link_required" as const };
    }
    if (isEntitledEmail(email) || !(await registrationAllowed(email))) {
      await tx.update(linkedinAuthTransactions).set({ pendingKind: "recovery_required", chosenEmail: null }).where(eq(linkedinAuthTransactions.id, pending.id));
      return { kind: "recovery_required" as const };
    }
    await tx.update(linkedinAuthTransactions).set({ pendingKind: "create_account", chosenEmail: email,
      appEmailVerifiedAt: now, expiresAt: new Date(now.getTime() + LINKEDIN_PENDING_MS) }).where(eq(linkedinAuthTransactions.id, pending.id));
    return { kind: "create_account" as const };
  });
}

/** Explicit account creation after provider-verified or app-verified email, under the shared users fence. */
export async function createLinkedInAccountIn(database: Db, cookie: string | undefined, now = new Date()) {
  return database.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ava:users'))`);
    const pending = await lockedPending(tx as unknown as Db, cookie, now);
    if (!pending || pending.pendingKind !== "create_account" || !pending.subject || !pending.verifiedAt || pending.completedAt) throw new Error("LinkedIn sign-in expired");
    const email = pending.appEmailVerifiedAt ? pending.chosenEmail : pending.providerEmailVerified ? pending.providerEmail : null;
    if (!email || emailProblem(email)) throw new Error("This address needs the ordinary account route");
    const [existingEmail] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    const [existingSubject] = await tx.select({ userId: authAccounts.userId }).from(authAccounts)
      .where(and(eq(authAccounts.provider, "linkedin"), eq(authAccounts.providerAccountId, pending.subject))).limit(1);
    if (existingSubject) throw new Error("This LinkedIn identity is already linked");
    if (existingEmail) {
      await tx.update(linkedinAuthTransactions).set({ pendingKind: "link_required", targetUserId: existingEmail.id }).where(eq(linkedinAuthTransactions.id, pending.id));
      return { kind: "link_required" as const };
    }
    if (isEntitledEmail(email) || !(await registrationAllowed(email))) throw new Error("This address needs the ordinary account route");
    const [user] = await tx.insert(users).values({ email, name: pending.name, role: "member", emailVerifiedAt: now, claimedAt: now, lastLoginAt: now, createdAt: now }).returning();
    await seedTagVocabulary(tx, user!.id);
    await ensureFreeEntitlement(tx, user!.id);
    await tx.insert(authAccounts).values({ userId: user!.id, provider: "linkedin", providerAccountId: pending.subject, email, name: pending.name });
    await tx.update(linkedinAuthTransactions).set(cleared()).where(eq(linkedinAuthTransactions.id, pending.id));
    return { kind: "signed_in" as const, user: user!, next: pending.nextPath === "/" ? "/library?onboarding=linkedin#library-import-linkedin" : pending.nextPath };
  });
}
