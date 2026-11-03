import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createUser, schema, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { hashPassword } from "@col/core";
import { createTestDb } from "@/test/db";

const client = createTestDb();
const database: Db = client.db;
let current: { user: typeof schema.users.$inferSelect; sessionId: string } | null = null;
const jar = new Map<string, string>();
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => current,
  requireUser: async () => { if (!current) throw new Error("Unauthorised"); return current.user; },
  clientAddress: async () => "198.51.100.20",
  startSession: vi.fn(async () => "new-session"),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => jar.has(name) ? { value: jar.get(name)! } : undefined, delete: (name: string) => jar.delete(name) }),
  headers: async () => new Headers({ host: "col.test" }),
}));

import { completeLinkedInLink, unlinkLinkedIn } from "./linkedin";
import { LINKEDIN_COOKIE, claimLinkedInCallback, settleLinkedInIdentity, startLinkedInTransaction } from "@/lib/linkedin-auth";

beforeAll(() => runMigrations(database));
afterAll(() => client.pool.end());
beforeEach(async () => {
  process.env.ADMIN_EMAILS = "owner@example.com";
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  current = null;
  jar.clear();
  await database.execute(sql`truncate users, settings, login_attempts restart identity cascade`);
});

it("links only after the real current-account password succeeds; wrong password and foreign account preserve the subject", async () => {
  const password = "correct horse battery staple";
  const owner = await createUser(database, { email: "member@example.com", emailVerified: true, passwordHash: await hashPassword(password) });
  const foreign = await createUser(database, { email: "foreign@example.com", emailVerified: true, passwordHash: await hashPassword(password) });
  const [ownerSession] = await database.insert(schema.sessions).values({ userId: owner.user.id, authProvider: "password", createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 60_000) }).returning();
  const [foreignSession] = await database.insert(schema.sessions).values({ userId: foreign.user.id, authProvider: "password", expiresAt: new Date(Date.now() + 60_000) }).returning();
  const pending = await startLinkedInTransaction(database, { intent: "sign_in", next: "/library" });
  jar.set(LINKEDIN_COOKIE, pending.cookie);
  await claimLinkedInCallback(database, { cookie: pending.cookie, state: pending.state });
  expect((await settleLinkedInIdentity(database, pending.cookie, { issuer: "https://www.linkedin.com/oauth", sub: "real-password-subject", email: "member@example.com", emailVerified: true, name: "Member" })).kind).toBe("link_required");
  current = { user: foreign.user, sessionId: foreignSession!.id };
  const wrongOwner = new FormData(); wrongOwner.set("password", password);
  expect(await completeLinkedInLink(wrongOwner)).toMatchObject({ ok: false, error: expect.stringContaining("account") });
  current = { user: owner.user, sessionId: ownerSession!.id };
  const wrongPassword = new FormData(); wrongPassword.set("password", "wrong password");
  expect(await completeLinkedInLink(wrongPassword)).toMatchObject({ ok: false, error: "That password is not right." });
  expect(await database.select().from(schema.authAccounts).where(and(eq(schema.authAccounts.provider, "linkedin"), eq(schema.authAccounts.providerAccountId, "real-password-subject")))).toHaveLength(0);
  const valid = new FormData(); valid.set("password", password);
  expect(await completeLinkedInLink(valid)).toMatchObject({ ok: true, nextSnapshot: { href: "/library" } });
  expect(await database.select().from(schema.authAccounts).where(and(eq(schema.authAccounts.provider, "linkedin"), eq(schema.authAccounts.providerAccountId, "real-password-subject")))).toHaveLength(1);
});

it("does not disconnect the last method or accept a LinkedIn session as alternate proof", async () => {
  const owner = await createUser(database, { email: "unlink@example.com", emailVerified: true });
  await database.insert(schema.authAccounts).values({ userId: owner.user.id, provider: "linkedin", providerAccountId: "unlink-subject" });
  const [linkedInSession] = await database.insert(schema.sessions).values({ userId: owner.user.id, authProvider: "linkedin", expiresAt: new Date(Date.now() + 60_000) }).returning();
  current = { user: owner.user, sessionId: linkedInSession!.id };
  expect(await unlinkLinkedIn()).toMatchObject({ ok: false, error: expect.stringContaining("another sign-in method") });
  await database.update(schema.users).set({ passwordHash: await hashPassword("alternate password") }).where(eq(schema.users.id, owner.user.id));
  expect(await unlinkLinkedIn()).toMatchObject({ ok: false, error: expect.stringContaining("Sign in again") });
  const [stalePassword] = await database.insert(schema.sessions).values({ userId: owner.user.id, authProvider: "password", createdAt: new Date(Date.now() - 11 * 60_000), expiresAt: new Date(Date.now() + 60_000) }).returning();
  current = { user: owner.user, sessionId: stalePassword!.id };
  expect(await unlinkLinkedIn()).toMatchObject({ ok: false, error: expect.stringContaining("Sign in again") });
  const [freshPassword] = await database.insert(schema.sessions).values({ userId: owner.user.id, authProvider: "password", expiresAt: new Date(Date.now() + 60_000) }).returning();
  current = { user: owner.user, sessionId: freshPassword!.id };
  expect(await unlinkLinkedIn()).toMatchObject({ ok: true });
  expect(await database.select().from(schema.authAccounts).where(and(eq(schema.authAccounts.userId, owner.user.id), eq(schema.authAccounts.provider, "linkedin")))).toHaveLength(0);
  expect(await database.select().from(schema.sessions).where(eq(schema.sessions.id, linkedInSession!.id))).toHaveLength(0);
  expect(await database.select().from(schema.sessions).where(eq(schema.sessions.id, freshPassword!.id))).toHaveLength(1);
});

it("requires configured Google as a usable alternative and only unlinks the owned account", async () => {
  const owner = await createUser(database, { email: "google-owner@example.com", emailVerified: true });
  const another = await createUser(database, { email: "other-owner@example.com", emailVerified: true });
  await database.insert(schema.authAccounts).values([
    { userId: owner.user.id, provider: "linkedin", providerAccountId: "owner-subject" },
    { userId: owner.user.id, provider: "google", providerAccountId: "google-owner" },
    { userId: another.user.id, provider: "linkedin", providerAccountId: "other-subject" },
  ]);
  const [googleSession] = await database.insert(schema.sessions).values({ userId: owner.user.id, authProvider: "google", expiresAt: new Date(Date.now() + 60_000) }).returning();
  current = { user: owner.user, sessionId: googleSession!.id };
  expect(await unlinkLinkedIn()).toMatchObject({ ok: false, error: expect.stringContaining("another sign-in method") });
  process.env.GOOGLE_CLIENT_ID = "configured-client";
  process.env.GOOGLE_CLIENT_SECRET = "configured-secret";
  expect(await unlinkLinkedIn()).toMatchObject({ ok: true });
  const remaining = await database.select().from(schema.authAccounts);
  expect(remaining.map(row => `${row.provider}:${row.providerAccountId}`).sort()).toEqual(["google:google-owner", "linkedin:other-subject"]);
  expect(await database.select().from(schema.sessions).where(eq(schema.sessions.id, googleSession!.id))).toHaveLength(1);
});
