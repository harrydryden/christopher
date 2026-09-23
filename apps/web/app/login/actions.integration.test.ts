import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];

vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "ava.test", "x-forwarded-for": "198.51.100.20" }),
  cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }),
}));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

import { login } from "./actions";
import { registerWithPassword } from "@/lib/accounts";
import { LIMITS } from "@/lib/rate-limit";

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "login-actions-test-secret";
});
beforeEach(async () => {
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
