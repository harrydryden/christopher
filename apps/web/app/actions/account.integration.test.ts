/**
 * The signed-in account actions that send mail or check a password. Both are cheap to call in a
 * loop from one session, so each is throttled the way the public sign-in and reset forms are.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, createUser, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";
import { createSessionCookieValue, DEFAULT_SESSION_TTL_SECONDS } from "@/lib/session";
import { hashPassword, verifyPassword } from "@ava/core";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;

vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session ? { value: session } : undefined) }),
  headers: async () => new Headers({ host: "ava.test", "x-forwarded-for": "198.51.100.30" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; text: string }>);
vi.mock("@/lib/email", async (original) => ({
  ...(await original<typeof import("@/lib/email")>()),
  sendEmail: vi.fn(async (mail: { to: string; subject: string; text: string }) => { sent.push(mail); return { delivered: true }; }),
}));

import { changePassword, resendVerification } from "./account";
import { resendConfirmation } from "@/app/login/actions";
import { LIMITS } from "@/lib/rate-limit";

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "account-actions-test-secret";
  process.env.APP_URL = "https://ava.test";
});
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  sent.length = 0;
  session = undefined;
  await database.execute(sql`truncate users, login_attempts, settings restart identity cascade`);
});

const PASSWORD = "correct horse battery staple";

/** A signed-in member whose address is confirmed or not, with a password when one is given. */
async function signIn(email: string, verified: boolean, password?: string) {
  const passwordHash = password ? await hashPassword(password) : null;
  const { user } = await createUser(database, { email, name: "Member", role: "member", emailVerified: verified, passwordHash });
  const expiresAt = new Date(Date.now() + DEFAULT_SESSION_TTL_SECONDS * 1000);
  const [row] = await database.insert(schema.sessions).values({ userId: user.id, expiresAt }).returning({ id: schema.sessions.id });
  session = await createSessionCookieValue(process.env.SESSION_SECRET!, row!.id, expiresAt);
  return { user, sessionId: row!.id };
}

const outcome = (work: Promise<void>) => work.then(() => "sent", (error: Error) => error.message);
const verificationMails = () => sent.filter(mail => mail.subject.startsWith("Confirm your email"));

it("sends the confirmation link again only as often as the public form would, then says so", async () => {
  const { user } = await signIn("squatted@example.com", false);
  const results: string[] = [];
  for (let i = 0; i < LIMITS.resetEmail.max + 2; i++) results.push(await outcome(resendVerification()));
  expect(results.filter(result => result === "sent")).toHaveLength(LIMITS.resetEmail.max);
  expect(results.slice(LIMITS.resetEmail.max)).toEqual(["redirect:/account?verify=rate_limited", "redirect:/account?verify=rate_limited"]);
  expect(verificationMails()).toHaveLength(LIMITS.resetEmail.max);
  const rows = await database.select().from(schema.loginAttempts).where(eq(schema.loginAttempts.key, `reset:email:${user.email}`));
  expect(rows).toHaveLength(LIMITS.resetEmail.max);
});

it("shares one budget with the public confirmation form for the same address", async () => {
  await signIn("shared@example.com", false);
  const form = new FormData();
  form.set("email", "shared@example.com");
  for (let i = 0; i < LIMITS.resetEmail.max; i++) await outcome(resendConfirmation(form));
  expect(verificationMails()).toHaveLength(LIMITS.resetEmail.max);
  expect(await outcome(resendVerification())).toBe("redirect:/account?verify=rate_limited");
  expect(verificationMails()).toHaveLength(LIMITS.resetEmail.max);
});

it("spends nothing for an address that is already confirmed", async () => {
  await signIn("confirmed@example.com", true);
  for (let i = 0; i < LIMITS.resetEmail.max + 2; i++) expect(await outcome(resendVerification())).toBe("sent");
  expect(sent).toHaveLength(0);
  expect(await database.select().from(schema.loginAttempts)).toHaveLength(0);
});

const passwordForm = (currentPassword: string, password: string) => {
  const form = new FormData();
  form.set("currentPassword", currentPassword);
  form.set("password", password);
  form.set("confirm", password);
  return form;
};
const storedHash = async (userId: string) => (await database.select().from(schema.users).where(eq(schema.users.id, userId)))[0]!.passwordHash!;

it("stops checking the current password after five wrong ones in fifteen minutes, even a right one", async () => {
  const { user } = await signIn("guessed@example.com", true, PASSWORD);
  const before = await storedHash(user.id);
  for (let i = 0; i < LIMITS.passwordChange.max; i++) {
    expect(await changePassword({ ok: true }, passwordForm(`wrong guess ${i}`, "a brand new password"))).toMatchObject({ ok: false });
  }
  // The right password is refused too: the check itself is never reached, so the form is no oracle.
  expect(await changePassword({ ok: true }, passwordForm(PASSWORD, "a brand new password")))
    .toEqual({ ok: false, error: "Too many attempts. Try again in 15 minutes." });
  expect(await storedHash(user.id)).toBe(before);
});

it("spends no attempt on a new password that fails the cheap checks", async () => {
  await signIn("typo@example.com", true, PASSWORD);
  for (let i = 0; i < LIMITS.passwordChange.max + 1; i++) {
    expect(await changePassword({ ok: true }, passwordForm("wrong guess", "short"))).toEqual({ ok: false, error: "Use at least 10 characters." });
  }
  expect(await database.select().from(schema.loginAttempts)).toHaveLength(0);
});

it("changes the password, clears its attempts and signs every other browser out", async () => {
  const { user, sessionId } = await signIn("changer@example.com", true, PASSWORD);
  await database.insert(schema.sessions).values({ userId: user.id, expiresAt: new Date(Date.now() + 60_000) });
  expect(await changePassword({ ok: true }, passwordForm("wrong guess", "a brand new password"))).toMatchObject({ ok: false });
  expect(await changePassword({ ok: true }, passwordForm(PASSWORD, "a brand new password"))).toEqual({ ok: true });
  expect(await verifyPassword("a brand new password", await storedHash(user.id))).toBe(true);
  expect(await database.select().from(schema.loginAttempts)).toHaveLength(0);
  const left = await database.select().from(schema.sessions).where(eq(schema.sessions.userId, user.id));
  expect(left.map(row => row.id)).toEqual([sessionId]);
});
