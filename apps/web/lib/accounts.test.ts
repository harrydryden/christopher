/**
 * Account lifecycle against a real database: registration and roles, password sign-in, the
 * migrated owner's claim, Google linking, single-use reset and verification links, throttling.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOTSTRAP_EMAIL, BOOTSTRAP_USER_ID, createDb, SEED_TAGS, schema, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { eq, sql } from "drizzle-orm";
let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
vi.mock("@/lib/db", () => ({ db: () => database }));
import { authenticateWithPassword, changePassword, registerWithPassword, requestPasswordReset, resetPasswordWithToken, sendVerificationEmail, signInWithGoogle, verifyEmailWithToken } from "./accounts";
import { consumeAuthToken, issueAuthToken } from "./auth-tokens";
import { clearAttempts, isRateLimited, LIMITS, recordAttempt } from "./rate-limit";

const PASSWORD = "correct horse battery staple";

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());
beforeEach(async () => {
  delete process.env.ADMIN_EMAILS;
  delete process.env.RESEND_API_KEY;
  await database.execute(sql`truncate users, login_attempts, companies, settings restart identity cascade`);
});

/** Email is not configured in tests, so the link lands in the log. */
function tokenFromLog(log: { mock: { calls: unknown[][] } }, path: string): string {
  const mails = log.mock.calls
    .map(([line]) => { try { return JSON.parse(String(line)) as { event?: string; text?: string }; } catch { return null; } })
    .filter((entry): entry is { event: string; text: string } => !!entry && entry.event === "email_not_configured" && typeof entry.text === "string" && entry.text.includes(path));
  return mails.at(-1)?.text.match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? "";
}
const sessionsFor = (userId: string) => database.select().from(schema.sessions).where(eq(schema.sessions.userId, userId));

describe("registration and sign-in", () => {
  it("makes the first account an administrator, later ones members, with normalised unique emails", async () => {
    const { user: ada, claimedBootstrap } = await registerWithPassword({ email: " Ada@Example.com ", password: PASSWORD, name: "Ada" });
    expect(claimedBootstrap).toBe(false);
    expect(ada).toMatchObject({ email: "ada@example.com", role: "admin", name: "Ada" });
    expect(ada.claimedAt).not.toBeNull();
    expect(ada.passwordHash).toMatch(/^scrypt\$/);
    const { user: bob } = await registerWithPassword({ email: "bob@example.com", password: PASSWORD });
    expect(bob.role).toBe("member");
    await expect(registerWithPassword({ email: "ADA@example.com", password: PASSWORD })).rejects.toThrow(/already/i);
    await expect(registerWithPassword({ email: "not-an-email", password: PASSWORD })).rejects.toThrow(/valid email/);
    await expect(registerWithPassword({ email: "carol@example.com", password: "short" })).rejects.toThrow(/at least/);
    // Every account starts with its own copy of the reason vocabulary.
    const tags = await database.select().from(schema.tagVocabulary).where(eq(schema.tagVocabulary.userId, bob.id));
    expect(tags).toHaveLength(SEED_TAGS.length);
  });

  it("checks passwords in constant shape and refuses accounts without one", async () => {
    await registerWithPassword({ email: "ada@example.com", password: PASSWORD });
    expect((await authenticateWithPassword("Ada@example.com", PASSWORD))?.email).toBe("ada@example.com");
    expect(await authenticateWithPassword("ada@example.com", "wrong password here")).toBeNull();
    expect(await authenticateWithPassword("nobody@example.com", PASSWORD)).toBeNull();
    await signInWithGoogle({ sub: "google-1", email: "g@example.com", emailVerified: true });
    expect(await authenticateWithPassword("g@example.com", PASSWORD)).toBeNull();
  });

  it("requires the current password to change it, unless the account never had one", async () => {
    const { user } = await registerWithPassword({ email: "ada@example.com", password: PASSWORD });
    await expect(changePassword(user, "not the password", "another fine password")).rejects.toThrow(/current password/);
    await expect(changePassword(user, PASSWORD, "short")).rejects.toThrow(/at least/);
    await changePassword(user, PASSWORD, "another fine password");
    expect(await authenticateWithPassword("ada@example.com", "another fine password")).not.toBeNull();
    const { user: google } = await signInWithGoogle({ sub: "google-1", email: "g@example.com", emailVerified: true });
    await changePassword(google, "", "a password for google user");
    expect(await authenticateWithPassword("g@example.com", "a password for google user")).not.toBeNull();
  });
});

describe("the migrated owner", () => {
  async function bootstrapWithData() {
    await database.insert(schema.users).values({ id: BOOTSTRAP_USER_ID, email: BOOTSTRAP_EMAIL, role: "admin", claimedAt: null });
    const [company] = await database.insert(schema.companies).values({ name: "Acme", domain: "acme.example", homepageUrl: "https://acme.example" }).returning();
    await database.insert(schema.companySubscriptions).values({ userId: BOOTSTRAP_USER_ID, companyId: company!.id });
  }

  it("is claimed by the first sign-up when no administrator addresses are configured", async () => {
    await bootstrapWithData();
    expect(await authenticateWithPassword(BOOTSTRAP_EMAIL, PASSWORD)).toBeNull();
    const { user, claimedBootstrap } = await registerWithPassword({ email: "owner@example.com", password: PASSWORD });
    expect(claimedBootstrap).toBe(true);
    expect(user).toMatchObject({ id: BOOTSTRAP_USER_ID, email: "owner@example.com", role: "admin" });
    expect(user.claimedAt).not.toBeNull();
    expect(await database.select().from(schema.companySubscriptions).where(eq(schema.companySubscriptions.userId, user.id))).toHaveLength(1);
    expect(await authenticateWithPassword("owner@example.com", PASSWORD)).not.toBeNull();
    // The next sign-up is an ordinary member with nothing inherited.
    const { user: other, claimedBootstrap: again } = await registerWithPassword({ email: "other@example.com", password: PASSWORD });
    expect(again).toBe(false);
    expect(other.role).toBe("member");
  });

  it("is only claimed by a configured administrator address when ADMIN_EMAILS is set", async () => {
    await bootstrapWithData();
    process.env.ADMIN_EMAILS = "Owner@Example.com";
    const { user: stranger, claimedBootstrap: strangerClaimed } = await registerWithPassword({ email: "stranger@example.com", password: PASSWORD });
    expect(strangerClaimed).toBe(false);
    expect(stranger.id).not.toBe(BOOTSTRAP_USER_ID);
    expect(stranger.role).toBe("member");
    const { user: owner, claimedBootstrap } = await registerWithPassword({ email: "owner@example.com", password: PASSWORD });
    expect(claimedBootstrap).toBe(true);
    expect(owner).toMatchObject({ id: BOOTSTRAP_USER_ID, role: "admin" });
  });
});

describe("Google sign-in", () => {
  it("creates, links and re-uses accounts, and refuses an unverified Google email", async () => {
    const first = await signInWithGoogle({ sub: "google-1", email: "New@Example.com", emailVerified: true, name: "New Person" });
    expect(first.created).toBe(true);
    expect(first.user).toMatchObject({ email: "new@example.com", role: "admin", name: "New Person" });
    expect(first.user.emailVerifiedAt).not.toBeNull();
    const again = await signInWithGoogle({ sub: "google-1", email: "changed@example.com", emailVerified: false });
    expect(again.created).toBe(false);
    expect(again.user.id).toBe(first.user.id);
    await expect(signInWithGoogle({ sub: "google-2", email: "unverified@example.com", emailVerified: false })).rejects.toThrow(/not verified/);
    expect(await database.select().from(schema.users)).toHaveLength(1);
  });

  it("takes over an unverified password account for the proven owner of the address", async () => {
    const { user } = await registerWithPassword({ email: "ada@example.com", password: PASSWORD });
    await database.insert(schema.sessions).values({ userId: user.id, expiresAt: new Date(Date.now() + 60_000) });
    const linked = await signInWithGoogle({ sub: "google-ada", email: "ada@example.com", emailVerified: true });
    expect(linked.created).toBe(false);
    expect(linked.user.id).toBe(user.id);
    const [stored] = await database.select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(stored!.passwordHash).toBeNull();
    expect(stored!.emailVerifiedAt).not.toBeNull();
    expect(await sessionsFor(user.id)).toHaveLength(0);
    expect(await authenticateWithPassword("ada@example.com", PASSWORD)).toBeNull();
    expect(await database.select().from(schema.authAccounts)).toMatchObject([{ userId: user.id, provider: "google", providerAccountId: "google-ada" }]);
  });

  it("links to a verified password account without touching its password or sessions", async () => {
    const { user } = await registerWithPassword({ email: "ada@example.com", password: PASSWORD });
    await database.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, user.id));
    await database.insert(schema.sessions).values({ userId: user.id, expiresAt: new Date(Date.now() + 60_000) });
    const linked = await signInWithGoogle({ sub: "google-ada", email: "ada@example.com", emailVerified: true });
    expect(linked.user.id).toBe(user.id);
    expect(await authenticateWithPassword("ada@example.com", PASSWORD)).not.toBeNull();
    expect(await sessionsFor(user.id)).toHaveLength(1);
  });
});

describe("single-use links", () => {
  it("resets the password once, signs the account out everywhere and expires", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const { user } = await registerWithPassword({ email: "ada@example.com", password: PASSWORD });
      await database.insert(schema.sessions).values([{ userId: user.id, expiresAt: new Date(Date.now() + 60_000) }, { userId: user.id, expiresAt: new Date(Date.now() + 60_000) }]);
      await requestPasswordReset("nobody@example.com", "https://app.example");
      expect(tokenFromLog(log, "/reset-password")).toBe("");
      await requestPasswordReset("Ada@example.com", "https://app.example");
      const token = tokenFromLog(log, "/reset-password");
      expect(token).not.toBe("");
      await expect(resetPasswordWithToken(token, "short")).rejects.toThrow(/at least/);
      const reset = await resetPasswordWithToken(token, "a brand new password");
      expect(reset?.id).toBe(user.id);
      expect(reset?.emailVerifiedAt).not.toBeNull();
      expect(await sessionsFor(user.id)).toHaveLength(0);
      expect(await authenticateWithPassword("ada@example.com", "a brand new password")).not.toBeNull();
      expect(await authenticateWithPassword("ada@example.com", PASSWORD)).toBeNull();
      expect(await resetPasswordWithToken(token, "yet another password")).toBeNull();
      // A newer link invalidates the older one; an old link has expired.
      const older = await issueAuthToken(user.id, "password_reset");
      const newer = await issueAuthToken(user.id, "password_reset");
      expect(await consumeAuthToken(older, "password_reset")).toBeNull();
      expect(await consumeAuthToken(newer, "password_reset")).toEqual({ userId: user.id });
      const stale = await issueAuthToken(user.id, "password_reset", new Date(Date.now() - 2 * 60 * 60 * 1000));
      expect(await consumeAuthToken(stale, "password_reset")).toBeNull();
      expect(await consumeAuthToken(newer, "email_verification")).toBeNull();
    } finally {
      log.mockRestore();
    }
  });

  it("confirms an email address once", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const { user } = await registerWithPassword({ email: "ada@example.com", password: PASSWORD });
      expect(user.emailVerifiedAt).toBeNull();
      expect(await sendVerificationEmail(user, "https://app.example")).toEqual({ delivered: false });
      const token = tokenFromLog(log, "/auth/verify");
      expect(token).not.toBe("");
      expect((await verifyEmailWithToken(token))?.emailVerifiedAt).not.toBeNull();
      expect(await verifyEmailWithToken(token)).toBeNull();
      expect(await verifyEmailWithToken("")).toBeNull();
      const [verified] = await database.select().from(schema.users).where(eq(schema.users.id, user.id));
      const before = await database.select().from(schema.authTokens);
      await sendVerificationEmail(verified!, "https://app.example");
      expect(await database.select().from(schema.authTokens)).toHaveLength(before.length);
    } finally {
      log.mockRestore();
    }
  });
});

describe("throttling", () => {
  it("counts attempts inside the window only, per key", async () => {
    const key = "login:email:ada@example.com";
    for (let i = 0; i < LIMITS.loginEmail.max - 1; i++) await recordAttempt(key);
    expect(await isRateLimited(key, LIMITS.loginEmail)).toBe(false);
    await recordAttempt(key);
    expect(await isRateLimited(key, LIMITS.loginEmail)).toBe(true);
    expect(await isRateLimited("login:email:bob@example.com", LIMITS.loginEmail)).toBe(false);
    await clearAttempts(key);
    expect(await isRateLimited(key, LIMITS.loginEmail)).toBe(false);
    const past = new Date(Date.now() - LIMITS.loginEmail.windowMs - 1000);
    for (let i = 0; i < LIMITS.loginEmail.max; i++) await recordAttempt(key, past);
    expect(await isRateLimited(key, LIMITS.loginEmail)).toBe(false);
  });
});
