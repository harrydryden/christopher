import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
/** The caller's address, as the platform's proxy reports it. */
let forwardedFor = "198.51.100.20";

vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "ava.test", "x-forwarded-for": forwardedFor }),
  cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }),
}));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
/** Work an action hands to `after()`: held until the test runs it, as the platform does once the answer is sent. */
const deferred = vi.hoisted(() => [] as Array<() => Promise<unknown>>);
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: (task: () => Promise<unknown>) => { deferred.push(task); },
}));
const runDeferred = async () => { while (deferred.length) await deferred.shift()!(); };

import { login, requestReset, resendConfirmation, signup } from "./actions";
import { registerWithPassword } from "@/lib/accounts";
import { LIMITS } from "@/lib/rate-limit";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "login-actions-test-secret";
});
beforeEach(async () => {
  forwardedFor = "198.51.100.20";
  deferred.length = 0;
  delete process.env.ADMIN_EMAILS;
  await database.execute(sql`truncate users, login_attempts, settings restart identity cascade`);
});
afterAll(async () => { await pool.end(); });

const attempt = async (n: number): Promise<string> => {
  const form = new FormData();
  form.set("email", `unknown-${n}@example.com`);
  form.set("password", "wrong password");
  try {
    await login(form);
    return "completed without redirect";
  } catch (error) {
    return String(error instanceof Error ? error.message : error);
  }
};

it("admits exactly the address limit when sign-in attempts arrive concurrently", async () => {
  const results = await Promise.all(Array.from({ length: LIMITS.loginAddress.max + 10 }, (_, n) => attempt(n)));
  expect(results.filter(result => result.includes("error=invalid"))).toHaveLength(LIMITS.loginAddress.max);
  expect(results.filter(result => result.includes("error=rate_limited"))).toHaveLength(10);
  const addressRows = await database.select().from(schema.loginAttempts)
    .where(eq(schema.loginAttempts.key, "login:ip:198.51.100.20"));
  expect(addressRows).toHaveLength(LIMITS.loginAddress.max);
});

it("a successful login releases only its own address reservation", async () => {
  await database.insert(schema.settings).values({ key: "registrationOpen", value: true });
  await registerWithPassword({ email: "member@example.com", password: "correct horse battery staple", name: "Member" });
  const addressKey = "login:ip:198.51.100.20";
  await database.insert(schema.loginAttempts).values([{ key: addressKey }, { key: addressKey }]);
  const form = new FormData();
  form.set("email", "member@example.com");
  form.set("password", "correct horse battery staple");
  await expect(login(form)).rejects.toThrow("redirect:/");
  const rows = await database.select().from(schema.loginAttempts);
  expect(rows.filter(row => row.key === addressKey)).toHaveLength(2);
  expect(rows.filter(row => row.key === "login:email:member@example.com")).toHaveLength(0);
  expect(rows.filter(row => row.key === "login:email-ip:member@example.com:198.51.100.20")).toHaveLength(0);
});

const signInAs = async (password: string, from: string) => {
  forwardedFor = from;
  const form = new FormData();
  form.set("email", "member@example.com");
  form.set("password", password);
  return login(form).then(() => "completed without redirect", (error: Error) => error.message);
};

it("does not let a stranger's failures turn away the owner's correct password from another address", async () => {
  await database.insert(schema.settings).values({ key: "registrationOpen", value: true });
  await registerWithPassword({ email: "member@example.com", password: "correct horse battery staple", name: "Member" });
  for (let i = 0; i < LIMITS.loginEmailAddress.max; i++) expect(await signInAs("wrong password", "198.51.100.20")).toContain("error=invalid");
  expect(await signInAs("wrong password", "198.51.100.20")).toContain("error=rate_limited");
  // The owner, from their own address, still gets in; the stranger stays limited.
  expect(await signInAs("correct horse battery staple", "203.0.113.9")).toBe("redirect:/");
  expect(await signInAs("correct horse battery staple", "198.51.100.20")).toContain("error=rate_limited");
  const rows = await database.select().from(schema.loginAttempts);
  expect(rows.filter(row => row.key === "login:email:member@example.com")).toHaveLength(0);
  // A refused attempt reserves nothing, so the stranger's address holds only its five failures.
  expect(rows.filter(row => row.key === "login:ip:198.51.100.20")).toHaveLength(LIMITS.loginEmailAddress.max);
});

it("still bounds guessing spread across many addresses", async () => {
  await database.insert(schema.settings).values({ key: "registrationOpen", value: true });
  await registerWithPassword({ email: "member@example.com", password: "correct horse battery staple", name: "Member" });
  for (let i = 0; i < LIMITS.loginEmail.max; i++) expect(await signInAs("wrong password", `192.0.2.${i + 1}`)).toContain("error=invalid");
  expect(await signInAs("correct horse battery staple", "203.0.113.9")).toContain("error=rate_limited");
});

it("answers a reset request before any work is done for the address, known or not", async () => {
  await database.insert(schema.settings).values({ key: "registrationOpen", value: true });
  await registerWithPassword({ email: "member@example.com", password: "correct horse battery staple", name: "Member" });
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  try {
    for (const email of ["member@example.com", "nobody@example.com"]) {
      const form = new FormData();
      form.set("email", email);
      expect(await requestReset(form).then(() => "", (error: Error) => error.message)).toBe("redirect:/forgot-password?sent=1");
    }
    // Both answers came back with nothing issued: the token and the send are deferred work.
    expect(await database.select().from(schema.authTokens)).toHaveLength(0);
    expect(deferred).toHaveLength(2);
    await runDeferred();
    const tokens = await database.select().from(schema.authTokens);
    expect(tokens.map(token => token.purpose)).toEqual(["password_reset"]);
  } finally {
    info.mockRestore();
  }
});

it("answers a confirmation resend the same way whether or not the address is waiting for one", async () => {
  const form = new FormData();
  form.set("email", "nobody@example.com");
  expect(await resendConfirmation(form).then(() => "", (error: Error) => error.message)).toBe("redirect:/signup?pending=1&email=nobody%40example.com&sent=1");
  expect(deferred).toHaveLength(1);
  await runDeferred();
  expect(await database.select().from(schema.authTokens)).toHaveLength(0);
});

it("checks the password before the registration rule, so a closed deployment does not reveal its administrator addresses", async () => {
  process.env.ADMIN_EMAILS = "owner@example.com";
  const attempt = async (email: string) => {
    const form = new FormData();
    form.set("email", email);
    form.set("password", "short");
    return signup(form).then(() => "", (error: Error) => error.message);
  };
  expect(await attempt("owner@example.com")).toContain("error=weak_password");
  expect(await attempt("stranger@example.com")).toContain("error=weak_password");
});

it("after a correct password, sends a next path that would leave the site to the home page instead", async () => {
  await database.insert(schema.settings).values({ key: "registrationOpen", value: true });
  await registerWithPassword({ email: "member@example.com", password: "correct horse battery staple", name: "Member" });
  const signIn = async (next: string) => {
    const form = new FormData();
    form.set("email", "member@example.com");
    form.set("password", "correct horse battery staple");
    form.set("next", next);
    return login(form).then(() => "completed without redirect", (error: Error) => error.message);
  };
  // A tab or newline is stripped by the browser's URL parser, which turns "/\t/host" into "//host".
  expect(await signIn("/\t/evil.example")).toBe("redirect:/");
  expect(await signIn("/\n/evil.example")).toBe("redirect:/");
  expect(await signIn("/.//evil.example")).toBe("redirect:/");
  expect(await signIn("/companies?page=2")).toBe("redirect:/companies?page=2");
});
