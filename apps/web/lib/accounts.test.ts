/**
 * Account lifecycle against a real database: who becomes an administrator and when, the migrated
 * owner's takeover, password sign-in, Google linking, single-use confirmation and reset links, throttling.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminEmailsFrom, BOOTSTRAP_EMAIL, BOOTSTRAP_USER_ID, completeAccountClaim, createDb, DEFAULT_ADMIN_EMAILS, lockAccountScoreInput, SEED_TAGS, schema, type Db } from "@col/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@col/db/migrate";
import { eq, sql } from "drizzle-orm";
import { hashPassword } from "@col/core";
let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
vi.mock("@/lib/db", () => ({ db: () => database }));
import { adminEmails, authenticateWithPassword, changePassword, confirmEmailWithToken, previewVerification, registerWithPassword, registrationAllowed, requestPasswordReset, resetPasswordWithToken, sendVerificationEmail, signInWithGoogle } from "./accounts";
import { consumeAuthToken, issueAuthToken, peekAuthToken } from "./auth-tokens";
import { clearAttempts, LIMITS, reserveRateLimits } from "./rate-limit";
import { getSettingsFor, saveSettingsAndGate } from "./settings";

const PASSWORD = "correct horse battery staple";
const OWNER = "owner@example.com";

beforeAll(async () => {
  const client = createTestDb();
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
const taskTypesFor = async (userId: string) => (await database.execute<{ type: string }>(sql`select type from tasks
  where payload->>'userId' = ${userId} order by type`)).rows.map(row => row.type);
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
    const [session] = await database.insert(schema.sessions).values({ userId: user.id, expiresAt: new Date(Date.now() + 60_000), authProvider: "password" }).returning();
    const done = await confirmEmailWithToken(token, { sessionUserId: user.id, sessionId: session!.id });
    expect(done.status).toBe("done");
    if (done.status === "done") {
      expect(done.user.role).toBe("member");
      expect(done.user.emailVerifiedAt).not.toBeNull();
    }
    expect(await confirmEmailWithToken(token, { sessionUserId: user.id, sessionId: session!.id })).toEqual({ status: "invalid" });
  });

  it("refuses a confirmation from a session revoked after the page loaded", async () => {
    const { user } = await registerWithPassword({ email: "revoked-confirm@example.com", password: PASSWORD });
    const token = await confirmationToken(user.id);
    const [session] = await database.insert(schema.sessions).values({ userId: user.id,
      expiresAt: new Date(Date.now() + 60_000), authProvider: "password" }).returning();
    await database.delete(schema.sessions).where(eq(schema.sessions.id, session!.id));
    expect(await confirmEmailWithToken(token, { sessionUserId: user.id, sessionId: session!.id })).toEqual({ status: "password" });
    expect(await peekAuthToken(token, "email_verification")).toEqual({ userId: user.id });
    const [stored] = await database.select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(stored!.emailVerifiedAt).toBeNull();
  });

  it("recovers saved decisions and shortlisted scoring once, with bounded reason fan-out", async () => {
    await openRegistration();
    const { user } = await registerWithPassword({ email: "learning-before-proof@example.com", password: PASSWORD });
    await database.insert(schema.userSettings).values({ userId: user.id, key: "seedProfile", value: "Operations leader" });
    const [company] = await database.insert(schema.companies).values({ name: "Acme", domain: "claim-acme.example", homepageUrl: "https://claim-acme.example" }).returning();
    const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://claim-acme.example/jobs" }).returning();
    const [job] = await database.insert(schema.jobs).values({ companyId: company!.id, sourceId: source!.id,
      externalKey: "one", title: "Operations Lead", normalizedTitle: "operations lead", url: "https://claim-acme.example/jobs/one" }).returning();
    await database.insert(schema.userJobs).values({ userId: user.id, jobId: job!.id, inTable: false });
    await database.insert(schema.decisions).values([
      { userId: user.id, jobId: job!.id, decision: "apply" as const, reason: "Good scope", jobTitle: "Operations Lead", companyName: "Acme" },
      ...Array.from({ length: 204 }, (_, i) => ({ userId: user.id, decision: "skip" as const,
        reason: `Reason ${i}`, jobTitle: `Old role ${i}`, companyName: "Past company" })),
    ]);
    expect(await taskTypesFor(user.id)).toEqual([]);

    const token = await confirmationToken(user.id);
    expect((await confirmEmailWithToken(token, { password: PASSWORD })).status).toBe("done");
    expect(await taskTypesFor(user.id)).toEqual(["rescore_all", "resume_reason_tags", "synthesize_profile"]);
    await database.execute(sql`delete from tasks`);
    await completeAccountClaim(database, user.id, { adminEmails: [OWNER] });
    expect(await taskTypesFor(user.id)).toEqual([]);
  });

  it.each(["reset", "google"] as const)("recovers a saved seed through %s confirmation", async channel => {
    await openRegistration();
    const { user } = await registerWithPassword({ email: `${channel}-seed@example.com`, password: PASSWORD });
    await database.insert(schema.userSettings).values({ userId: user.id, key: "seedProfile", value: "Operations leader" });
    if (channel === "reset") {
      const token = await issueAuthToken(user.id, "password_reset");
      expect((await resetPasswordWithToken(token, PASSWORD))?.id).toBe(user.id);
    } else {
      expect((await signInWithGoogle({ sub: "claim-seed-google", email: user.email, emailVerified: true, hostedDomain: "example.com" })).user.id).toBe(user.id);
    }
    expect(await taskTypesFor(user.id)).toEqual(["synthesize_profile"]);
  });

  it("rolls back confirmation if its saved-work task cannot be queued", async () => {
    await openRegistration();
    const { user } = await registerWithPassword({ email: "claim-rollback@example.com", password: PASSWORD });
    await database.insert(schema.decisions).values({ userId: user.id, decision: "skip", reason: "Wrong sector",
      jobTitle: "Operations", companyName: "Acme" });
    await database.execute(sql`alter table tasks add constraint reject_resume_reasons check (type <> 'resume_reason_tags') not valid`);
    try {
      await expect(completeAccountClaim(database, user.id, { adminEmails: [OWNER] })).rejects.toThrow();
      const [after] = await database.select().from(schema.users).where(eq(schema.users.id, user.id));
      expect(after!.emailVerifiedAt).toBeNull();
      expect(await taskTypesFor(user.id)).toEqual([]);
    } finally {
      await database.execute(sql`alter table tasks drop constraint reject_resume_reasons`);
    }
    expect((await completeAccountClaim(database, user.id, { adminEmails: [OWNER] }))?.emailVerifiedAt).not.toBeNull();
    expect(await taskTypesFor(user.id)).toEqual(["resume_reason_tags", "synthesize_profile"]);
  });

  it("retries a linked Google claim after a saved-work enqueue rolled back", async () => {
    await openRegistration();
    const { user } = await registerWithPassword({ email: "google-claim-retry@example.com", password: PASSWORD });
    await database.insert(schema.userSettings).values({ userId: user.id, key: "seedProfile", value: "Operations leader" });
    const profile = { sub: "google-claim-retry", email: user.email, emailVerified: true, hostedDomain: "example.com" };
    await database.execute(sql`alter table tasks add constraint reject_google_resume check (type <> 'synthesize_profile') not valid`);
    try {
      await expect(signInWithGoogle(profile)).rejects.toThrow();
      const [after] = await database.select().from(schema.users).where(eq(schema.users.id, user.id));
      expect(after!.emailVerifiedAt).toBeNull();
      expect(await taskTypesFor(user.id)).toEqual([]);
      expect(await database.select().from(schema.authAccounts).where(eq(schema.authAccounts.userId, user.id))).toHaveLength(1);
    } finally {
      await database.execute(sql`alter table tasks drop constraint reject_google_resume`);
    }
    expect((await signInWithGoogle(profile)).user.emailVerifiedAt).not.toBeNull();
    expect(await taskTypesFor(user.id)).toEqual(["synthesize_profile"]);
    await database.execute(sql`delete from tasks`);
    await signInWithGoogle(profile);
    expect(await taskTypesFor(user.id)).toEqual([]);
  });

  it("does not erase a password set while a Google link waits for the account fence", async () => {
    await openRegistration();
    const { user } = await registerWithPassword({ email: "google-reset-race@example.com", password: PASSWORD });
    await database.insert(schema.sessions).values({ userId: user.id, expiresAt: new Date(Date.now() + 60_000) });
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const lockReady = new Promise<void>(resolve => { locked = resolve; });
    const reset = database.transaction(async tx => {
      await lockAccountScoreInput(tx as unknown as Db, user.id, "exclusive");
      await tx.update(schema.users).set({ emailVerifiedAt: new Date(), passwordHash: "new-password-hash" })
        .where(eq(schema.users.id, user.id));
      locked();
      await held;
    });
    await lockReady;
    const linking = signInWithGoogle({ sub: "google-reset-race", email: user.email, emailVerified: true, hostedDomain: "example.com" });
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const state = await database.execute<{ waiting: boolean }>(sql`select exists (
          select 1 from pg_locks l where l.locktype = 'advisory' and l.granted = false
            and l.classid = 874302 and l.objid = hashtext(${user.id})::oid
            and l.database = (select oid from pg_database where datname = current_database())
        ) as waiting`);
        waiting = state.rows[0]?.waiting === true;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally {
      release();
      await reset;
    }
    expect((await linking).user.emailVerifiedAt).not.toBeNull();
    const [stored] = await database.select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(stored!.passwordHash).toBe("new-password-hash");
    expect(await sessionsFor(user.id)).toHaveLength(1);
  });

  it.each(["confirmation", "reset"] as const)("keeps a %s link and account state on saved-work enqueue failure", async channel => {
    await openRegistration();
    const { user } = await registerWithPassword({ email: `${channel}-atomic@example.com`, password: PASSWORD });
    await database.insert(schema.userSettings).values({ userId: user.id, key: "seedProfile", value: "Operations leader" });
    await database.insert(schema.sessions).values({ userId: user.id, expiresAt: new Date(Date.now() + 60_000) });
    const token = channel === "confirmation" ? await confirmationToken(user.id) : await issueAuthToken(user.id, "password_reset");
    const nextPassword = "a different and valid password";
    await database.execute(sql`alter table tasks add constraint reject_atomic_claim check (type <> 'synthesize_profile') not valid`);
    try {
      if (channel === "confirmation")
        await expect(confirmEmailWithToken(token, { password: PASSWORD })).rejects.toThrow();
      else await expect(resetPasswordWithToken(token, nextPassword)).rejects.toThrow();
      expect(await peekAuthToken(token, channel === "confirmation" ? "email_verification" : "password_reset"))
        .toEqual({ userId: user.id });
      const [after] = await database.select().from(schema.users).where(eq(schema.users.id, user.id));
      expect(after!.emailVerifiedAt).toBeNull();
      expect(after!.passwordHash).toBe(user.passwordHash);
      expect(await sessionsFor(user.id)).toHaveLength(1);
      expect(await taskTypesFor(user.id)).toEqual([]);
    } finally {
      await database.execute(sql`alter table tasks drop constraint reject_atomic_claim`);
    }
    if (channel === "confirmation")
      expect((await confirmEmailWithToken(token, { password: PASSWORD })).status).toBe("done");
    else {
      expect((await resetPasswordWithToken(token, nextPassword))?.emailVerifiedAt).not.toBeNull();
      expect(await sessionsFor(user.id)).toHaveLength(0);
      expect((await authenticateWithPassword(user.email, nextPassword)).status).toBe("ok");
    }
    expect(await taskTypesFor(user.id)).toEqual(["synthesize_profile"]);
    expect(await peekAuthToken(token, channel === "confirmation" ? "email_verification" : "password_reset")).toBeNull();
  });

  it("waits for a concurrent pre-confirmation save and includes it in recovery", async () => {
    await openRegistration();
    const { user } = await registerWithPassword({ email: "claim-race@example.com", password: PASSWORD });
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const lockReady = new Promise<void>(resolve => { locked = resolve; });
    const save = database.transaction(async tx => {
      await lockAccountScoreInput(tx as unknown as Db, user.id, "exclusive");
      await tx.insert(schema.userSettings).values({ userId: user.id, key: "seedProfile", value: "Operations leadership" });
      locked();
      await held;
    });
    await lockReady;
    let claimed = false;
    const confirmation = completeAccountClaim(database, user.id, { adminEmails: [OWNER] }).then(result => {
      claimed = true;
      return result;
    });
    try {
      // Observe the claim waiting on this exact account fence, rather than assuming a delay
      // proves the competing transaction reached the lock.
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const state = await database.execute<{ waiting: boolean }>(sql`select exists (
          select 1 from pg_locks l where l.locktype = 'advisory' and l.granted = false
            and l.classid = 874302 and l.database = (select oid from pg_database where datname = current_database())
        ) as waiting`);
        waiting = state.rows[0]?.waiting === true;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      expect(claimed).toBe(false);
    } finally {
      release();
      await save;
    }
    expect((await confirmation)?.emailVerifiedAt).not.toBeNull();
    expect(await taskTypesFor(user.id)).toEqual(["synthesize_profile"]);
  });

  it("lets a gate save waiting behind confirmation queue its own verified follow-up", async () => {
    await openRegistration();
    const { user } = await registerWithPassword({ email: "claim-gate-race@example.com", password: PASSWORD });
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const lockReady = new Promise<void>(resolve => { locked = resolve; });
    const usersLock = database.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ava:users'))`);
      locked();
      await held;
    });
    await lockReady;
    const confirmation = completeAccountClaim(database, user.id, { adminEmails: [OWNER] });
    try {
      let accountLocked = false;
      for (let attempt = 0; attempt < 100 && !accountLocked; attempt++) {
        const state = await database.execute<{ locked: boolean }>(sql`select exists (
          select 1 from pg_locks l where l.locktype = 'advisory' and l.granted = true
            and l.classid = 874302 and l.objid = hashtext(${user.id})::oid
            and l.database = (select oid from pg_database where datname = current_database())
        ) as locked`);
        accountLocked = state.rows[0]?.locked === true;
        if (!accountLocked) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(accountLocked).toBe(true);
      const settings = await getSettingsFor(user.id);
      const gateSave = saveSettingsAndGate(user.id, { gate: { ...settings.gate, includeKeywords: ["strategy"] } });
      release();
      await usersLock;
      expect((await confirmation)?.emailVerifiedAt).not.toBeNull();
      await gateSave;
      expect(await taskTypesFor(user.id)).toContain("rescore_all");
    } finally {
      release();
      await usersLock;
    }
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
    await signInWithGoogle({ sub: "google-1", email: "g@example.com", emailVerified: true, hostedDomain: "example.com" });
    expect((await authenticateWithPassword("g@example.com", PASSWORD)).status).toBe("invalid");
  });

  it("requires the current password or a fresh linked provider session to enrol one", async () => {
    const { user } = await registerWithPassword({ email: "ada@example.com", password: PASSWORD });
    await expect(changePassword(user, "not the password", "another fine password")).rejects.toThrow(/current password/);
    await expect(changePassword(user, PASSWORD, "short")).rejects.toThrow(/at least/);
    await changePassword(user, PASSWORD, "another fine password");
    expect((await authenticateWithPassword("ada@example.com", "another fine password")).status).toBe("ok");
    await openRegistration();
    const { user: google } = await signInWithGoogle({ sub: "google-1", email: "g@example.com", emailVerified: true, hostedDomain: "example.com" });
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-secret");
    const [fresh] = await database.insert(schema.sessions).values({ userId: google.id,
      expiresAt: new Date(Date.now() + 60_000), authProvider: "google" }).returning();
    await expect(changePassword(google, "", "a password for google user")).rejects.toThrow(/Sign in again/);
    const [legacy] = await database.insert(schema.sessions).values({ userId: google.id,
      expiresAt: new Date(Date.now() + 60_000) }).returning();
    await expect(changePassword(google, "", "a password for google user", legacy!.id)).rejects.toThrow(/Sign in again/);
    await database.update(schema.sessions).set({ createdAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(schema.sessions.id, fresh!.id));
    await expect(changePassword(google, "", "a password for google user", fresh!.id)).rejects.toThrow(/Sign in again/);
    await database.update(schema.sessions).set({ createdAt: new Date() }).where(eq(schema.sessions.id, fresh!.id));
    await changePassword(google, "", "a password for google user", fresh!.id);
    vi.unstubAllEnvs();
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
    const owner = await signInWithGoogle({ sub: "google-owner", email: OWNER, emailVerified: true, hostedDomain: "example.com" });
    expect(owner.created).toBe(false);
    expect(owner.user).toMatchObject({ id: BOOTSTRAP_USER_ID, email: OWNER, role: "admin" });
    expect(owner.user.claimedAt).not.toBeNull();
    expect((await authenticateWithPassword(OWNER, "attackers password 1")).status).toBe("invalid");
    expect(await database.select().from(schema.authAccounts)).toMatchObject([{ userId: BOOTSTRAP_USER_ID, providerAccountId: "google-owner" }]);
  });

  it("is claimed at once by a verified Google sign-in of an administrator address", async () => {
    await bootstrapWithData();
    const owner = await signInWithGoogle({ sub: "google-owner", email: OWNER, emailVerified: true, hostedDomain: "example.com", name: "Owner" });
    expect(owner.created).toBe(true);
    expect(owner.user).toMatchObject({ id: BOOTSTRAP_USER_ID, email: OWNER, role: "admin", name: "Owner" });
    expect(owner.user.claimedAt).not.toBeNull();
  });
});

describe("Google sign-in", () => {
  it("does not create or claim an account from an external verified email without hosted authority", async () => {
    await openRegistration();
    await expect(signInWithGoogle({ sub: "external-new", email: "new@outside.example", emailVerified: true }))
      .rejects.toThrow(/Sign in to your existing account/);
    const pendingAdmin = await registerWithPassword({ email: OWNER, password: PASSWORD });
    await expect(signInWithGoogle({ sub: "external-admin", email: OWNER, emailVerified: true }))
      .rejects.toThrow(/Sign in to your existing account/);
    const [stored] = await database.select().from(schema.users).where(eq(schema.users.id, pendingAdmin.user.id));
    expect(stored).toMatchObject({ role: "member", claimedAt: null, emailVerifiedAt: null });
    expect(await database.select().from(schema.authAccounts)).toHaveLength(0);
  });

  it("links an external Google subject only after a fresh live session for the same verified account", async () => {
    const owner = await registerWithPassword({ email: "external-owner@example.com", password: PASSWORD });
    const foreign = await registerWithPassword({ email: "foreign-proof@example.com", password: PASSWORD });
    const [session] = await database.insert(schema.sessions).values({ userId: owner.user.id,
      expiresAt: new Date(Date.now() + 60_000), authProvider: "password" }).returning();
    const [foreignSession] = await database.insert(schema.sessions).values({ userId: foreign.user.id,
      expiresAt: new Date(Date.now() + 60_000), authProvider: "password" }).returning();
    const profile = { sub: "external-sub", email: owner.user.email, emailVerified: true };
    await expect(signInWithGoogle(profile, { userId: owner.user.id, sessionId: session!.id }))
      .rejects.toThrow(/Sign in to your existing account/);
    await database.update(schema.users).set({ emailVerifiedAt: new Date() })
      .where(eq(schema.users.id, owner.user.id));
    await expect(signInWithGoogle(profile)).rejects.toThrow(/Sign in to your existing account/);
    await expect(signInWithGoogle(profile, { userId: foreign.user.id, sessionId: foreignSession!.id }))
      .rejects.toThrow(/Sign in to your existing account/);
    await expect(signInWithGoogle(profile, { userId: owner.user.id, sessionId: foreignSession!.id }))
      .rejects.toThrow(/Sign in to your existing account/);
    await database.update(schema.sessions).set({ createdAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(schema.sessions.id, session!.id));
    await expect(signInWithGoogle(profile, { userId: owner.user.id, sessionId: session!.id }))
      .rejects.toThrow(/Sign in to your existing account/);
    await database.update(schema.sessions).set({ createdAt: new Date() }).where(eq(schema.sessions.id, session!.id));
    expect((await signInWithGoogle(profile, { userId: owner.user.id, sessionId: session!.id })).user.id).toBe(owner.user.id);
    // The linked subject remains the account identity even when its external address later changes.
    expect((await signInWithGoogle({ sub: profile.sub, email: "changed@outside.example", emailVerified: false })).user.id).toBe(owner.user.id);
  });

  it("does not repair an unverified linked account from a changed Google email", async () => {
    const owner = await registerWithPassword({ email: "original@example.com", password: PASSWORD });
    await database.insert(schema.authAccounts).values({ userId: owner.user.id,
      provider: "google", providerAccountId: "legacy-linked-sub" });
    await expect(signInWithGoogle({ sub: "legacy-linked-sub", email: "different@example.com",
      emailVerified: true, hostedDomain: "example.com" })).rejects.toThrow(/Sign in to your existing account/);
    const [before] = await database.select().from(schema.users).where(eq(schema.users.id, owner.user.id));
    expect(before!.emailVerifiedAt).toBeNull();
    expect((await signInWithGoogle({ sub: "legacy-linked-sub", email: owner.user.email,
      emailVerified: true, hostedDomain: "example.com" })).user.emailVerifiedAt).not.toBeNull();
  });

  it("respects closed registration, creates members, re-uses links and refuses unverified emails", async () => {
    await expect(signInWithGoogle({ sub: "google-1", email: "new@example.com", emailVerified: true, hostedDomain: "example.com" })).rejects.toThrow(/closed/);
    expect(await database.select().from(schema.users)).toHaveLength(0);
    await openRegistration();
    const first = await signInWithGoogle({ sub: "google-1", email: "New@Example.com", emailVerified: true, hostedDomain: "example.com", name: "New Person" });
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
    const oldReset = await issueAuthToken(user.id, "password_reset");
    await database.insert(schema.sessions).values({ userId: user.id, expiresAt: new Date(Date.now() + 60_000) });
    const linked = await signInWithGoogle({ sub: "google-ada", email: "ada@example.com", emailVerified: true, hostedDomain: "example.com" });
    expect(linked.created).toBe(false);
    expect(linked.user.id).toBe(user.id);
    const [stored] = await database.select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(stored!.passwordHash).toBeNull();
    expect(stored!.emailVerifiedAt).not.toBeNull();
    expect(await sessionsFor(user.id)).toHaveLength(0);
    expect((await authenticateWithPassword("ada@example.com", PASSWORD)).status).toBe("invalid");
    expect(await resetPasswordWithToken(oldReset, "an attacker password again")).toBeNull();
    expect(await database.select().from(schema.authAccounts)).toMatchObject([{ userId: user.id, provider: "google", providerAccountId: "google-ada" }]);
  });

  it("does not restore a revoked unverified password from a stale change request", async () => {
    const { user } = await registerWithPassword({ email: "stale-change@example.com", password: PASSWORD });
    await signInWithGoogle({ sub: "google-stale-change", email: user.email, emailVerified: true, hostedDomain: "example.com" });
    await expect(changePassword(user, PASSWORD, "a different valid password"))
      .rejects.toThrow(/account changed/i);
    const [stored] = await database.select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(stored!.passwordHash).toBeNull();
    expect((await authenticateWithPassword(user.email, PASSWORD)).status).toBe("invalid");
  });

  it("does not rehash an old password over a concurrent reset", async () => {
    const { user } = await registerWithPassword({ email: "rehash-reset@example.com", password: PASSWORD });
    const replacement = "replacement password after reset";
    const replacementHash = await hashPassword(replacement);
    vi.stubEnv("COL_SCRYPT_N", "32768");
    let release!: () => void;
    let locked!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const reset = database.transaction(async tx => {
      await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, user.id)).for("update");
      locked();
      await hold;
      await tx.update(schema.users).set({ passwordHash: replacementHash }).where(eq(schema.users.id, user.id));
    });
    await ready;
    const signingIn = authenticateWithPassword(user.email, PASSWORD);
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 150 && !waiting; attempt++) {
        const status = await database.execute<{ waiting: boolean }>(sql`select exists (
          select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'
            and query ilike '%update%users%'
        ) as waiting`);
        waiting = status.rows[0]?.waiting === true;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
    } finally {
      release();
      await reset;
      vi.unstubAllEnvs();
    }
    expect((await signingIn).status).toBe("invalid");
    expect((await authenticateWithPassword(user.email, replacement)).status).toBe("ok");
  });

  it("binds concurrent Google callbacks to the subject rather than their different email snapshots", async () => {
    const first = await registerWithPassword({ email: "google-subject-a@example.com", password: PASSWORD });
    const second = await registerWithPassword({ email: "google-subject-b@example.com", password: PASSWORD });
    await database.update(schema.users).set({ emailVerifiedAt: new Date() })
      .where(eq(schema.users.id, first.user.id));
    await database.update(schema.users).set({ emailVerifiedAt: new Date() })
      .where(eq(schema.users.id, second.user.id));
    const results = await Promise.all([
      signInWithGoogle({ sub: "shared-google-subject", email: first.user.email, emailVerified: true, hostedDomain: "example.com" }),
      signInWithGoogle({ sub: "shared-google-subject", email: second.user.email, emailVerified: true, hostedDomain: "example.com" }),
    ]);
    expect(results[0]!.user.id).toBe(results[1]!.user.id);
    const links = await database.select().from(schema.authAccounts)
      .where(eq(schema.authAccounts.providerAccountId, "shared-google-subject"));
    expect(links).toHaveLength(1);
    expect(links[0]!.userId).toBe(results[0]!.user.id);
  });

  it("links to a verified password account without touching its password or sessions", async () => {
    const { user } = await registerWithPassword({ email: "ada@example.com", password: PASSWORD });
    await database.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, user.id));
    await database.insert(schema.sessions).values({ userId: user.id, expiresAt: new Date(Date.now() + 60_000) });
    const linked = await signInWithGoogle({ sub: "google-ada", email: "ada@example.com", emailVerified: true, hostedDomain: "example.com" });
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

      const changed = await changePassword(user, PASSWORD, "another fine password", kept!.id);
      expect(changed.user.passwordHash).toBe(changed.passwordHashProven);
      expect(changed.passwordHashProven).not.toBe(user.passwordHash);
      expect(await resetPasswordWithToken(reset, "the attacker's password")).toBeNull();
      expect((await confirmEmailWithToken(confirmation, { password: "another fine password" })).status).toBe("invalid");
      expect(await sessionsFor(user.id)).toHaveLength(0);
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
    const admitted = async (k = key) => (await reserveRateLimits([{ key: k, limit: LIMITS.loginEmail }])) !== null;
    for (let i = 0; i < LIMITS.loginEmail.max; i++) expect(await admitted()).toBe(true);
    expect(await admitted()).toBe(false);
    expect(await admitted("login:email:bob@example.com")).toBe(true);
    await clearAttempts(key);
    expect(await admitted()).toBe(true);
    await clearAttempts(key);
    const past = new Date(Date.now() - LIMITS.loginEmail.windowMs - 1000);
    await database.insert(schema.loginAttempts).values(Array.from({ length: LIMITS.loginEmail.max }, () => ({ key, at: past })));
    expect(await admitted()).toBe(true);
  });
});
