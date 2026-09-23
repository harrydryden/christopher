/**
 * Account lifecycle against a real database: who becomes an administrator and when, the migrated
 * owner's takeover, password sign-in, Google linking, single-use confirmation and reset links, throttling.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminEmailsFrom, BOOTSTRAP_EMAIL, BOOTSTRAP_USER_ID, createDb, DEFAULT_ADMIN_EMAILS, SEED_TAGS, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";
let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
vi.mock("@/lib/db", () => ({ db: () => database }));
import { adminEmails, authenticateWithPassword, changePassword, confirmEmailWithToken, previewVerification, registerWithPassword, registrationAllowed, requestPasswordReset, resetPasswordWithToken, sendVerificationEmail, signInWithGoogle } from "./accounts";
import { consumeAuthToken, issueAuthToken } from "./auth-tokens";
import { clearAttempts, isRateLimited, LIMITS, recordAttempt } from "./rate-limit";

const PASSWORD = "correct horse battery staple";
const OWNER = "owner@example.com";

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());
beforeEach(async () => {
  process.env.ADMIN_EMAILS = OWNER;
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
const openRegistration = () => database.insert(schema.settings).values({ key: "registrationOpen", value: true });
async function confirmationToken(userId: string) {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const [user] = await database.select().from(schema.users).where(eq(schema.users.id, userId));
    await sendVerificationEmail(user!, "https://app.example");
    return tokenFromLog(log, "/auth/verify");
  } finally {
    log.mockRestore();
  }
}
async function bootstrapWithData() {
  await database.insert(schema.users).values({ id: BOOTSTRAP_USER_ID, email: BOOTSTRAP_EMAIL, role: "admin", claimedAt: null });
  const [company] = await database.insert(schema.companies).values({ name: "Acme", domain: "acme.example", homepageUrl: "https://acme.example" }).returning();
  await database.insert(schema.companySubscriptions).values({ userId: BOOTSTRAP_USER_ID, companyId: company!.id });
}

describe("who may register and what they get", () => {
  it("defaults the administrator address to the deployment owner when ADMIN_EMAILS is unset", () => {
    expect(adminEmailsFrom({})).toEqual(DEFAULT_ADMIN_EMAILS);
    expect(adminEmailsFrom({ ADMIN_EMAILS: " " })).toEqual(DEFAULT_ADMIN_EMAILS);
    expect(adminEmailsFrom({ ADMIN_EMAILS: "A@Example.com, b@example.com" })).toEqual(["a@example.com", "b@example.com"]);
    expect(DEFAULT_ADMIN_EMAILS).toContain("harryddryden@gmail.com");
  });

  it("keeps the default in production when ADMIN_EMAILS is unset, and says so in the log once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("ADMIN_EMAILS", " , ");
      expect(adminEmails()).toEqual(DEFAULT_ADMIN_EMAILS);
      expect(adminEmails()).toEqual(DEFAULT_ADMIN_EMAILS);
      const warnings = warn.mock.calls.filter(([line]) => String(line).includes("admin_emails_default"));
      expect(warnings).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      warn.mockRestore();
    }
    expect(adminEmails()).toEqual([OWNER]);
  });

  it("keeps registration closed to everyone but administrator addresses until an administrator opens it", async () => {
    expect(await registrationAllowed(OWNER)).toBe(true);
    expect(await registrationAllowed("stranger@example.com")).toBe(false);
    await openRegistration();
    expect(await registrationAllowed("stranger@example.com")).toBe(true);
  });

  it("signs members in at once but makes an administrator address wait for confirmation", async () => {
    const bob = await registerWithPassword({ email: "Bob@Example.com", password: PASSWORD, name: "Bob" });
    expect(bob.pending).toBe(false);
    expect(bob.user).toMatchObject({ email: "bob@example.com", role: "member", name: "Bob" });
    expect(bob.user.claimedAt).not.toBeNull();
    expect(bob.user.emailVerifiedAt).toBeNull();
    expect((await authenticateWithPassword("bob@example.com", PASSWORD)).status).toBe("ok");
    const owner = await registerWithPassword({ email: OWNER, password: PASSWORD });
    expect(owner.pending).toBe(true);
    expect(owner.user.claimedAt).toBeNull();
    expect(owner.user.role).toBe("member");
    expect((await authenticateWithPassword(OWNER, PASSWORD)).status).toBe("unconfirmed");
    expect((await authenticateWithPassword(OWNER, "not the password")).status).toBe("invalid");
    await expect(registerWithPassword({ email: "BOB@example.com", password: PASSWORD })).rejects.toThrow(/already/i);
    await expect(registerWithPassword({ email: BOOTSTRAP_EMAIL, password: PASSWORD })).rejects.toThrow(/valid email/);
    await expect(registerWithPassword({ email: "not-an-email", password: PASSWORD })).rejects.toThrow(/valid email/);
    await expect(registerWithPassword({ email: "carol@example.com", password: "short" })).rejects.toThrow(/at least/);
    const tags = await database.select().from(schema.tagVocabulary).where(eq(schema.tagVocabulary.userId, bob.user.id));
    expect(tags).toHaveLength(SEED_TAGS.length);
  });

  it("grants the administrator role only once the address is confirmed with the password", async () => {
    const { user } = await registerWithPassword({ email: OWNER, password: PASSWORD });
    const token = await confirmationToken(user.id);
    expect(token).not.toBe("");
    expect(await previewVerification(token)).toMatchObject({ userId: user.id, email: OWNER, hasPassword: true, pending: true });
    expect(await confirmEmailWithToken(token, { password: "wrong password here" })).toEqual({ status: "password" });
    expect(await confirmEmailWithToken(token, { sessionUserId: "00000000-0000-4000-8000-00000000dead" })).toEqual({ status: "password" });
    expect((await database.select().from(schema.users).where(eq(schema.users.id, user.id)))[0]!.claimedAt).toBeNull();
    const done = await confirmEmailWithToken(token, { password: PASSWORD });
    expect(done.status).toBe("done");
    if (done.status !== "done") return;
    expect(done.user).toMatchObject({ id: user.id, role: "admin" });
    expect(done.user.claimedAt).not.toBeNull();
    expect(done.user.emailVerifiedAt).not.toBeNull();
    expect(await confirmEmailWithToken(token, { password: PASSWORD })).toEqual({ status: "invalid" });
    expect((await authenticateWithPassword(OWNER, PASSWORD)).status).toBe("ok");
  });

  it("lets a signed-in member confirm with one click and stay a member", async () => {
    const { user } = await registerWithPassword({ email: "bob@example.com", password: PASSWORD });
    const token = await confirmationToken(user.id);
    const done = await confirmEmailWithToken(token, { sessionUserId: user.id });
    expect(done.status).toBe("done");
    if (done.status === "done") {
      expect(done.user.role).toBe("member");
      expect(done.user.emailVerifiedAt).not.toBeNull();
    }
    expect(await confirmEmailWithToken(token, { sessionUserId: user.id })).toEqual({ status: "invalid" });
  });

  it("promotes a verified member whose address is listed later, at the next sign-in", async () => {
    process.env.ADMIN_EMAILS = "someone-else@example.com";
    const { user } = await registerWithPassword({ email: "late@example.com", password: PASSWORD });
    await database.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, user.id));
    process.env.ADMIN_EMAILS = "late@example.com";
    const signIn = await authenticateWithPassword("late@example.com", PASSWORD);
    expect(signIn.status).toBe("ok");
    if (signIn.status === "ok") expect(signIn.user.role).toBe("admin");
  });

  it("checks passwords in constant shape and refuses accounts without one", async () => {
    await registerWithPassword({ email: "ada@example.com", password: PASSWORD });
    expect((await authenticateWithPassword("Ada@example.com", PASSWORD)).status).toBe("ok");
    expect((await authenticateWithPassword("ada@example.com", "wrong password here")).status).toBe("invalid");
    expect((await authenticateWithPassword("nobody@example.com", PASSWORD)).status).toBe("invalid");
    await openRegistration();
    await signInWithGoogle({ sub: "google-1", email: "g@example.com", emailVerified: true });
    expect((await authenticateWithPassword("g@example.com", PASSWORD)).status).toBe("invalid");
  });

  it("requires the current password to change it, unless the account never had one", async () => {
    const { user } = await registerWithPassword({ email: "ada@example.com", password: PASSWORD });
    await expect(changePassword(user, "not the password", "another fine password")).rejects.toThrow(/current password/);
    await expect(changePassword(user, PASSWORD, "short")).rejects.toThrow(/at least/);
    await changePassword(user, PASSWORD, "another fine password");
    expect((await authenticateWithPassword("ada@example.com", "another fine password")).status).toBe("ok");
    await openRegistration();
    const { user: google } = await signInWithGoogle({ sub: "google-1", email: "g@example.com", emailVerified: true });
    await changePassword(google, "", "a password for google user");
    expect((await authenticateWithPassword("g@example.com", "a password for google user")).status).toBe("ok");
  });
});

describe("the migrated owner", () => {
  it("is taken over only by an administrator address, and only once that address is proven", async () => {
    await bootstrapWithData();
    await openRegistration();
    const stranger = await registerWithPassword({ email: "stranger@example.com", password: PASSWORD });
    expect(stranger.claimedBootstrap).toBe(false);
    expect(stranger.user.id).not.toBe(BOOTSTRAP_USER_ID);
    expect(stranger.user.role).toBe("member");
    const owner = await registerWithPassword({ email: OWNER, password: PASSWORD });
    expect(owner.claimedBootstrap).toBe(true);
    expect(owner.pending).toBe(true);
    expect(owner.user.id).toBe(BOOTSTRAP_USER_ID);
    expect(owner.user.email).toBe(OWNER);
    expect((await authenticateWithPassword(OWNER, PASSWORD)).status).toBe("unconfirmed");
    // A reset link proves the address just as well as the confirmation link.
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await requestPasswordReset(OWNER, "https://app.example");
      const reset = await resetPasswordWithToken(tokenFromLog(log, "/reset-password"), "a brand new password");
      expect(reset).toMatchObject({ id: BOOTSTRAP_USER_ID, email: OWNER, role: "admin" });
      expect(reset!.claimedAt).not.toBeNull();
    } finally {
      log.mockRestore();
    }
    expect((await authenticateWithPassword(OWNER, "a brand new password")).status).toBe("ok");
    expect(await database.select().from(schema.companySubscriptions).where(eq(schema.companySubscriptions.userId, BOOTSTRAP_USER_ID))).toHaveLength(1);
    // The next administrator address gets an ordinary new account.
    process.env.ADMIN_EMAILS = `${OWNER},second@example.com`;
    const second = await registerWithPassword({ email: "second@example.com", password: PASSWORD });
    expect(second.claimedBootstrap).toBe(false);
    expect(second.pending).toBe(true);
  });

  it("gives an attacker who registers the owner's address first nothing, and the real owner everything via Google", async () => {
    await bootstrapWithData();
    const attacker = await registerWithPassword({ email: OWNER, password: "attackers password 1" });
    expect(attacker.pending).toBe(true);
    expect((await authenticateWithPassword(OWNER, "attackers password 1")).status).toBe("unconfirmed");
    const owner = await signInWithGoogle({ sub: "google-owner", email: OWNER, emailVerified: true });
    expect(owner.created).toBe(false);
    expect(owner.user).toMatchObject({ id: BOOTSTRAP_USER_ID, email: OWNER, role: "admin" });
    expect(owner.user.claimedAt).not.toBeNull();
    expect((await authenticateWithPassword(OWNER, "attackers password 1")).status).toBe("invalid");
    expect(await database.select().from(schema.authAccounts)).toMatchObject([{ userId: BOOTSTRAP_USER_ID, providerAccountId: "google-owner" }]);
  });

  it("is claimed at once by a verified Google sign-in of an administrator address", async () => {
    await bootstrapWithData();
    const owner = await signInWithGoogle({ sub: "google-owner", email: OWNER, emailVerified: true, name: "Owner" });
    expect(owner.created).toBe(true);
    expect(owner.user).toMatchObject({ id: BOOTSTRAP_USER_ID, email: OWNER, role: "admin", name: "Owner" });
    expect(owner.user.claimedAt).not.toBeNull();
  });
});

describe("Google sign-in", () => {
  it("respects closed registration, creates members, re-uses links and refuses unverified emails", async () => {
    await expect(signInWithGoogle({ sub: "google-1", email: "new@example.com", emailVerified: true })).rejects.toThrow(/closed/);
    expect(await database.select().from(schema.users)).toHaveLength(0);
    await openRegistration();
    const first = await signInWithGoogle({ sub: "google-1", email: "New@Example.com", emailVerified: true, name: "New Person" });
    expect(first.created).toBe(true);
    expect(first.user).toMatchObject({ email: "new@example.com", role: "member", name: "New Person" });
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
    expect((await authenticateWithPassword("ada@example.com", PASSWORD)).status).toBe("invalid");
    expect(await database.select().from(schema.authAccounts)).toMatchObject([{ userId: user.id, provider: "google", providerAccountId: "google-ada" }]);
  });

  it("links to a verified password account without touching its password or sessions", async () => {
    const { user } = await registerWithPassword({ email: "ada@example.com", password: PASSWORD });
    await database.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, user.id));
    await database.insert(schema.sessions).values({ userId: user.id, expiresAt: new Date(Date.now() + 60_000) });
    const linked = await signInWithGoogle({ sub: "google-ada", email: "ada@example.com", emailVerified: true });
    expect(linked.user.id).toBe(user.id);
    expect((await authenticateWithPassword("ada@example.com", PASSWORD)).status).toBe("ok");
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
      await requestPasswordReset("Ada@example.com", null);
      expect(tokenFromLog(log, "/reset-password")).toBe("");
      await requestPasswordReset("Ada@example.com", "https://app.example");
      const token = tokenFromLog(log, "/reset-password");
      expect(token).not.toBe("");
      await expect(resetPasswordWithToken(token, "short")).rejects.toThrow(/at least/);
      const reset = await resetPasswordWithToken(token, "a brand new password");
      expect(reset?.id).toBe(user.id);
      expect(reset?.emailVerifiedAt).not.toBeNull();
      expect(reset?.role).toBe("member");
      expect(await sessionsFor(user.id)).toHaveLength(0);
      expect((await authenticateWithPassword("ada@example.com", "a brand new password")).status).toBe("ok");
      expect((await authenticateWithPassword("ada@example.com", PASSWORD)).status).toBe("invalid");
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

  it("retires every outstanding link and every other session when the password changes", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const { user } = await registerWithPassword({ email: "ada@example.com", password: PASSWORD });
      const [kept] = await database.insert(schema.sessions)
        .values([{ userId: user.id, expiresAt: new Date(Date.now() + 60_000) }, { userId: user.id, expiresAt: new Date(Date.now() + 60_000) }])
        .returning();
      // A reset link someone requested while they briefly had the mailbox, and a confirmation link.
      await requestPasswordReset("ada@example.com", "https://app.example");
      const reset = tokenFromLog(log, "/reset-password");
      expect(reset).not.toBe("");
      const confirmation = await confirmationToken(user.id);
      expect(confirmation).not.toBe("");

      await changePassword(user, PASSWORD, "another fine password", kept!.id);
      expect(await resetPasswordWithToken(reset, "the attacker's password")).toBeNull();
      expect((await confirmEmailWithToken(confirmation, { password: "another fine password" })).status).toBe("invalid");
      expect((await sessionsFor(user.id)).map(row => row.id)).toEqual([kept!.id]);
      expect((await authenticateWithPassword("ada@example.com", "another fine password")).status).toBe("ok");
    } finally {
      log.mockRestore();
    }
  });

  it("does not issue confirmation links for verified accounts or without an origin", async () => {
    const { user } = await registerWithPassword({ email: "ada@example.com", password: PASSWORD });
    expect(await sendVerificationEmail(user, null)).toEqual({ delivered: false });
    expect(await database.select().from(schema.authTokens)).toHaveLength(0);
    const token = await confirmationToken(user.id);
    expect(token).not.toBe("");
    expect(await previewVerification("")).toBeNull();
    expect(await previewVerification("x".repeat(201))).toBeNull();
    const done = await confirmEmailWithToken(token, { password: PASSWORD });
    expect(done.status).toBe("done");
    const [verified] = await database.select().from(schema.users).where(eq(schema.users.id, user.id));
    const before = await database.select().from(schema.authTokens);
    expect(await sendVerificationEmail(verified!, "https://app.example")).toEqual({ delivered: false });
    expect(await database.select().from(schema.authTokens)).toHaveLength(before.length);
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
