/**
 * The hourly `lastSeenAt` touch runs through `after()`, so the platform waits for it instead of
 * freezing the instance with the write in flight, and never makes the request wait. Outside a
 * request, where `after()` throws, it still runs.
 *
 * Requires a database: set TEST_DATABASE_URL (defaults to the local ava_test database).
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { signInTestUser } from "@/test/auth";
import { createTestDb } from "@/test/db";

const SECRET = "auth-touch-test-secret-0123456789abcdef";
const { db, pool } = createTestDb();
let cookie: string | undefined;
const deferred: Array<() => unknown> = [];
const after = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ db: () => db }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (cookie ? { value: cookie } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after }));

import { getCurrentUser } from "./auth";

const HOURS_AGO = (hours: number) => new Date(Date.now() - hours * 3_600_000);

beforeAll(() => runMigrations(db));
afterAll(() => pool.end());
beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", SECRET);
  deferred.length = 0;
  after.mockReset().mockImplementation((task: () => unknown) => { deferred.push(task); });
});

async function sessionSeen(hours: number) {
  const signed = await signInTestUser(db, SECRET, "auth-touch@example.com");
  await db.update(schema.sessions).set({ lastSeenAt: HOURS_AGO(hours) }).where(eq(schema.sessions.id, signed.sessionId));
  cookie = signed.cookie;
  return signed.sessionId;
}

const lastSeen = async (id: string) => (await db.select({ at: schema.sessions.lastSeenAt }).from(schema.sessions).where(eq(schema.sessions.id, id)))[0]!.at;

it("hands a stale session's touch to after(), and writes nothing until the platform runs it", async () => {
  const id = await sessionSeen(2);
  const before = await lastSeen(id);
  const current = await getCurrentUser();
  expect(current?.sessionId).toBe(id);
  expect(after).toHaveBeenCalledTimes(1);
  expect(await lastSeen(id)).toEqual(before);
  await deferred[0]!();
  expect((await lastSeen(id)).getTime()).toBeGreaterThan(Date.now() - 60_000);
});

it("leaves a session seen within the hour alone", async () => {
  const id = await sessionSeen(0.5);
  const before = await lastSeen(id);
  await getCurrentUser();
  expect(after).not.toHaveBeenCalled();
  expect(await lastSeen(id)).toEqual(before);
});

it("still records the touch outside a request, where after() refuses", async () => {
  after.mockImplementation(() => { throw new Error("`after` was called outside a request scope."); });
  const id = await sessionSeen(3);
  await getCurrentUser();
  await vi.waitFor(async () => expect((await lastSeen(id)).getTime()).toBeGreaterThan(Date.now() - 60_000));
});
