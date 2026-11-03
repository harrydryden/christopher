import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { schema, createUser, BOOTSTRAP_EMAIL, BOOTSTRAP_USER_ID, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { createTestDb } from "@/test/db";
import { beginLinkedInEmailProofIn, claimLinkedInCallback, completeLinkedInEmailProofIn, completeLinkedInLinkIn, createLinkedInAccountIn, readLinkedInPending, settleLinkedInIdentity, startLinkedInTransaction } from "./linkedin-auth";
import type { LinkedInIdentity } from "./linkedin";

const client = createTestDb();
const database: Db = client.db;
vi.mock("@/lib/db", () => ({ db: () => database }));
beforeAll(() => runMigrations(database));
afterAll(() => client.pool.end());
beforeEach(async () => {
  process.env.ADMIN_EMAILS = "owner@example.com";
  await database.execute(sql`truncate users, settings, login_attempts restart identity cascade`);
});

const identity = (sub: string, email: string | null, emailVerified = true): LinkedInIdentity => ({
  issuer: "https://www.linkedin.com/oauth", sub, email, emailVerified, name: "Linked Member",
});
async function beginAndVerify(input: { sub: string; email: string | null; verified?: boolean; intent?: "sign_in" | "link"; userId?: string; sessionId?: string }) {
  const started = await startLinkedInTransaction(database, { intent: input.intent ?? "sign_in", next: "/roles?view=shortlisted", initiatingUserId: input.userId, initiatingSessionId: input.sessionId });
  expect(await claimLinkedInCallback(database, { cookie: started.cookie, state: "wrong" })).toBeNull();
  expect(await claimLinkedInCallback(database, { cookie: `${started.cookie}wrong`, state: started.state })).toBeNull();
  const claimed = await claimLinkedInCallback(database, { cookie: started.cookie, state: started.state });
  expect(claimed).not.toBeNull();
  expect(await claimLinkedInCallback(database, { cookie: started.cookie, state: started.state })).toBeNull();
  const result = await settleLinkedInIdentity(database, started.cookie, identity(input.sub, input.email, input.verified ?? true));
  return { started, result };
}
async function linked(subject: string) {
  return database.select().from(schema.authAccounts).where(and(eq(schema.authAccounts.provider, "linkedin"), eq(schema.authAccounts.providerAccountId, subject)));
}

it("does not create on callback; explicit creation is one-use and reopens by subject", async () => {
  await database.insert(schema.settings).values({ key: "registrationOpen", value: true });
  const { started, result } = await beginAndVerify({ sub: "pairwise-1", email: "NEW@EXAMPLE.COM" });
  expect(result.kind).toBe("create_account");
  expect(await database.select().from(schema.users)).toHaveLength(0);
  const created = await createLinkedInAccountIn(database, started.cookie);
  expect(created.kind).toBe("signed_in");
  if (created.kind !== "signed_in") return;
  expect(created.user).toMatchObject({ email: "new@example.com", role: "member" });
  expect(created.next).toBe("/roles?view=shortlisted");
  expect(await linked("pairwise-1")).toHaveLength(1);
  await expect(createLinkedInAccountIn(database, started.cookie)).rejects.toThrow(/expired/);
  const again = await beginAndVerify({ sub: "pairwise-1", email: null, verified: false });
  expect(again.result).toMatchObject({ kind: "signed_in", user: { id: created.user.id } });
});

it("keeps matching email and closed registration on explicit verified account linking", async () => {
  const existing = await createUser(database, { email: "existing@example.com", emailVerified: true, passwordHash: "hash" });
  const { started, result } = await beginAndVerify({ sub: "pairwise-2", email: "EXISTING@example.com" });
  expect(result.kind).toBe("link_required");
  const pending = await readLinkedInPending(database, started.cookie);
  expect(pending?.targetUserId).toBe(existing.user.id);
  const [session] = await database.insert(schema.sessions).values({ userId: existing.user.id, expiresAt: new Date(Date.now() + 60_000), authProvider: "password", createdAt: new Date(Date.now() - 30_000) }).returning();
  await expect(completeLinkedInLinkIn(database, { cookie: started.cookie, userId: existing.user.id, sessionId: session!.id, passwordProven: false })).rejects.toThrow(/Sign in again/);
  const done = await completeLinkedInLinkIn(database, { cookie: started.cookie, userId: existing.user.id, sessionId: session!.id, passwordProven: true });
  expect(done.userId).toBe(existing.user.id);
  expect(await linked("pairwise-2")).toHaveLength(1);
  await expect(completeLinkedInLinkIn(database, { cookie: started.cookie, userId: existing.user.id, sessionId: session!.id, passwordProven: true })).rejects.toThrow(/expired/);

  // The LinkedIn email can differ from an owned account, even while new registration is closed.
  const other = await beginAndVerify({ sub: "pairwise-3", email: "different@example.com" });
  expect(other.result.kind).toBe("recovery_required");
  const [fresh] = await database.insert(schema.sessions).values({ userId: existing.user.id, expiresAt: new Date(Date.now() + 60_000), authProvider: "google", createdAt: new Date(Date.now() + 1_000) }).returning();
  await completeLinkedInLinkIn(database, { cookie: other.started.cookie, userId: existing.user.id, sessionId: fresh!.id, passwordProven: false });
  expect(await linked("pairwise-3")).toHaveLength(1);
});

it("proves an absent or unverified provider email in the same browser before offering creation", async () => {
  await database.insert(schema.settings).values({ key: "registrationOpen", value: true });
  const { started, result } = await beginAndVerify({ sub: "pairwise-4", email: "unverified@example.com", verified: false });
  expect(result.kind).toBe("verify_email");
  const proof = await beginLinkedInEmailProofIn(database, { cookie: started.cookie, email: "Chosen@Example.com" });
  await expect(completeLinkedInEmailProofIn(database, { cookie: started.cookie, token: "wrong" })).rejects.toThrow(/valid/);
  expect((await completeLinkedInEmailProofIn(database, { cookie: started.cookie, token: proof.token })).kind).toBe("create_account");
  await expect(completeLinkedInEmailProofIn(database, { cookie: started.cookie, token: proof.token })).rejects.toThrow(/valid/);
  const created = await createLinkedInAccountIn(database, started.cookie);
  expect(created.kind).toBe("signed_in");
  if (created.kind === "signed_in") expect(created.user.email).toBe("chosen@example.com");
});

it("never links an unverified password account, even with a fresh password proof", async () => {
  const attacker = await createUser(database, { email: "victim@example.com", passwordHash: "hash" });
  const [session] = await database.insert(schema.sessions).values({ userId: attacker.user.id, expiresAt: new Date(Date.now() + 60_000), authProvider: "password" }).returning();
  const { started, result } = await beginAndVerify({ sub: "pairwise-5", email: "victim@example.com" });
  expect(result.kind).toBe("link_required");
  await expect(completeLinkedInLinkIn(database, { cookie: started.cookie, userId: attacker.user.id, sessionId: session!.id, passwordProven: true })).rejects.toThrow(/Verify the account email/);
  expect(await linked("pairwise-5")).toHaveLength(0);
});

it("serialises a new LinkedIn account against normalised password registration and duplicate subjects", async () => {
  await database.insert(schema.settings).values({ key: "registrationOpen", value: true });
  const left = await beginAndVerify({ sub: "pairwise-race", email: "RACE@example.com" });
  const [creation, signup] = await Promise.allSettled([
    createLinkedInAccountIn(database, left.started.cookie),
    createUser(database, { email: "race@EXAMPLE.COM", passwordHash: "test-hash" }),
  ]);
  const usersForEmail = await database.select().from(schema.users).where(eq(schema.users.email, "race@example.com"));
  expect(usersForEmail).toHaveLength(1);
  const raceLinks = await linked("pairwise-race");
  expect(raceLinks).toHaveLength(creation.status === "fulfilled" && creation.value.kind === "signed_in" ? 1 : 0);
  if (signup.status === "fulfilled") expect(creation.status === "rejected" || creation.value.kind === "link_required").toBe(true);
  if (raceLinks.length) expect(raceLinks[0]!.userId).toBe(usersForEmail[0]!.id);

  const second = await beginAndVerify({ sub: "pairwise-race", email: "other@example.com" });
  if (await linked("pairwise-race").then(rows => rows.length)) expect(second.result.kind).toBe("signed_in");
  else expect(second.result.kind).toBe("create_account");
});

it("allows only one account/link when two pending callbacks claim the same subject concurrently", async () => {
  await database.insert(schema.settings).values({ key: "registrationOpen", value: true });
  const one = await beginAndVerify({ sub: "shared-pairwise", email: "one@example.com" });
  const two = await beginAndVerify({ sub: "shared-pairwise", email: "two@example.com" });
  expect([one.result.kind, two.result.kind]).toEqual(["create_account", "create_account"]);
  const results = await Promise.allSettled([createLinkedInAccountIn(database, one.started.cookie), createLinkedInAccountIn(database, two.started.cookie)]);
  expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
  expect(await linked("shared-pairwise")).toHaveLength(1);
  expect(await database.select().from(schema.users)).toHaveLength(1);
});

it("cannot create or claim the migrated owner through a LinkedIn email", async () => {
  await database.insert(schema.users).values({ id: BOOTSTRAP_USER_ID, email: BOOTSTRAP_EMAIL, role: "admin", claimedAt: null });
  const pending = await beginAndVerify({ sub: "pairwise-admin", email: "owner@example.com" });
  expect(pending.result.kind).toBe("recovery_required");
  await expect(createLinkedInAccountIn(database, pending.started.cookie)).rejects.toThrow(/expired/);
  const [bootstrap] = await database.select().from(schema.users).where(eq(schema.users.id, BOOTSTRAP_USER_ID));
  expect(bootstrap?.claimedAt).toBeNull();
  expect(await linked("pairwise-admin")).toHaveLength(0);
});

it("requires a different, freshly authenticated alternate session for linking", async () => {
  const existing = await createUser(database, { email: "confirmed@example.com", emailVerified: true });
  const [old] = await database.insert(schema.sessions).values({ userId: existing.user.id, expiresAt: new Date(Date.now() + 60_000), authProvider: "google", createdAt: new Date(Date.now() - 60_000) }).returning();
  const pending = await beginAndVerify({ sub: "pairwise-fresh", email: "confirmed@example.com", intent: "link", userId: existing.user.id, sessionId: old!.id });
  await expect(completeLinkedInLinkIn(database, { cookie: pending.started.cookie, userId: existing.user.id, sessionId: old!.id, passwordProven: false })).rejects.toThrow(/Sign in again/);
  const verifiedAt = (await readLinkedInPending(database, pending.started.cookie))!.verifiedAt!;
  const [equal] = await database.insert(schema.sessions).values({ userId: existing.user.id, expiresAt: new Date(Date.now() + 3_600_000), authProvider: "google", createdAt: verifiedAt }).returning();
  await expect(completeLinkedInLinkIn(database, { cookie: pending.started.cookie, userId: existing.user.id, sessionId: equal!.id, passwordProven: false })).rejects.toThrow(/Sign in again/);
  const [fresh] = await database.insert(schema.sessions).values({ userId: existing.user.id, expiresAt: new Date(Date.now() + 3_600_000), authProvider: "google", createdAt: new Date(verifiedAt.getTime() + 1_000) }).returning();
  await expect(completeLinkedInLinkIn(database, { cookie: pending.started.cookie, userId: existing.user.id, sessionId: fresh!.id, passwordProven: false, now: new Date(verifiedAt.getTime() + 11 * 60_000) })).rejects.toThrow(/Sign in again/);
  expect((await completeLinkedInLinkIn(database, { cookie: pending.started.cookie, userId: existing.user.id, sessionId: fresh!.id, passwordProven: false, now: new Date(verifiedAt.getTime() + 2_000) })).userId).toBe(existing.user.id);
});

it("sends a new account with no deep destination to the guided Library import", async () => {
  await database.insert(schema.settings).values({ key: "registrationOpen", value: true });
  const started = await startLinkedInTransaction(database, { intent: "sign_in", next: "/" });
  await claimLinkedInCallback(database, { cookie: started.cookie, state: started.state });
  expect((await settleLinkedInIdentity(database, started.cookie, identity("pairwise-onboard", "onboard@example.com"))).kind).toBe("create_account");
  const created = await createLinkedInAccountIn(database, started.cookie);
  expect(created.kind).toBe("signed_in");
  if (created.kind === "signed_in") expect(created.next).toBe("/library?onboarding=linkedin#library-import-linkedin");
});

it("lets a missing-email member link to an existing verified account after fresh reauthentication", async () => {
  const existing = await createUser(database, { email: "my-account@example.com", emailVerified: true });
  const pending = await beginAndVerify({ sub: "pairwise-no-email", email: null });
  expect(pending.result.kind).toBe("verify_email");
  const [session] = await database.insert(schema.sessions).values({ userId: existing.user.id, expiresAt: new Date(Date.now() + 60_000), authProvider: "password", createdAt: new Date(Date.now() + 1_000) }).returning();
  const linkedResult = await completeLinkedInLinkIn(database, { cookie: pending.started.cookie, userId: existing.user.id, sessionId: session!.id, passwordProven: false });
  expect(linkedResult.userId).toBe(existing.user.id);
  expect(await linked("pairwise-no-email")).toHaveLength(1);
});
