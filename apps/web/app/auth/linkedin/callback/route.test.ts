/** A callback must claim its short-lived browser-bound state before any provider exchange. */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { schema } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { createTestDb } from "@/test/db";

const jar = new Map<string, string>();
let database: ReturnType<typeof createTestDb>["db"];

vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (name: string) => jar.has(name) ? { value: jar.get(name)! } : undefined,
  delete: (name: string) => { jar.delete(name); },
}) }));
vi.mock("@/lib/linkedin", async original => ({
  ...(await original<typeof import("@/lib/linkedin")>()),
  exchangeLinkedInCode: vi.fn(async () => "verified-token"),
  verifyLinkedInIdToken: vi.fn(async () => ({ issuer: "https://www.linkedin.com/oauth", sub: "subject", email: "person@example.test", emailVerified: true, name: "Test Person" })),
}));
vi.mock("@/lib/linkedin-auth", async original => ({
  ...(await original<typeof import("@/lib/linkedin-auth")>()),
  settleLinkedInIdentity: vi.fn(async () => ({ kind: "signed_in", user: { id: "user-1" }, next: "/account" })),
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => null), startSession: vi.fn(async () => "session") }));

import { GET } from "./route";
import { exchangeLinkedInCode } from "@/lib/linkedin";
import { LINKEDIN_COOKIE, startLinkedInTransaction } from "@/lib/linkedin-auth";
import { startSession } from "@/lib/auth";

let pool: ReturnType<typeof createTestDb>["pool"];
beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate linkedin_auth_transactions restart identity cascade`);
  jar.clear();
  vi.clearAllMocks();
  process.env.APP_URL = "http://col.test";
  process.env.LINKEDIN_CLIENT_ID = "test-client";
  process.env.LINKEDIN_CLIENT_SECRET = "test-secret";
});

async function started() {
  const flow = await startLinkedInTransaction(database, { intent: "sign_in", next: "/account" });
  jar.set(LINKEDIN_COOKIE, flow.cookie);
  return flow;
}
const callback = (state: string, query = "code=code") => GET(new Request(`http://col.test/auth/linkedin/callback?state=${encodeURIComponent(state)}&${query}`));
const error = (response: Response) => new URL(response.headers.get("location")!).searchParams.get("error");

it("exchanges once only after a valid claim; replay cannot call the provider again", async () => {
  const flow = await started();
  const first = await callback(flow.state);
  expect(first.status).toBe(307);
  expect(first.headers.get("location")).toBe("http://col.test/account");
  expect(first.headers.get("cache-control")).toContain("no-store");
  expect(first.headers.get("referrer-policy")).toBe("no-referrer");
  expect(exchangeLinkedInCode).toHaveBeenCalledTimes(1);
  expect(startSession).toHaveBeenCalledTimes(1);

  const replay = await callback(flow.state);
  expect(error(replay)).toBe("linkedin_state");
  expect(replay.headers.get("cache-control")).toContain("no-store");
  expect(replay.headers.get("referrer-policy")).toBe("no-referrer");
  expect(exchangeLinkedInCode).toHaveBeenCalledTimes(1);
  expect(startSession).toHaveBeenCalledTimes(1);
});

it("refuses a different browser and an expired transaction before provider exchange", async () => {
  const flow = await started();
  jar.set(LINKEDIN_COOKIE, `${flow.cookie.slice(0, flow.cookie.indexOf("."))}.${"x".repeat(43)}`);
  expect(error(await callback(flow.state))).toBe("linkedin_state");
  expect(exchangeLinkedInCode).not.toHaveBeenCalled();

  jar.set(LINKEDIN_COOKIE, flow.cookie);
  await database.update(schema.linkedinAuthTransactions).set({ expiresAt: new Date(Date.now() - 1_000) });
  expect(error(await callback(flow.state))).toBe("linkedin_state");
  expect(exchangeLinkedInCode).not.toHaveBeenCalled();
});

it("consumes a cancelled state without exchanging or signing in", async () => {
  const flow = await started();
  expect(error(await callback(flow.state, "error=user_cancelled_login"))).toBe("linkedin_cancelled");
  expect(exchangeLinkedInCode).not.toHaveBeenCalled();
  expect(startSession).not.toHaveBeenCalled();
  expect(error(await callback(flow.state))).toBe("linkedin_state");
});
