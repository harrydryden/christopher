import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { schema } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { createTestDb } from "@/test/db";

const client = createTestDb();
const database = client.db;
vi.mock("@/lib/db", () => ({ db: () => database }));
import { consumeRateLimit, releaseRateLimitReservations, reserveRateLimits } from "./rate-limit";

// Measure actual driver statements rather than a mocked counter implementation. A sign-in
// checks three quotas; its normal request must not pay a separate round trip for each count.
let statements: string[] = [];
client.pool.on("connect", connection => {
  const original = connection.query;
  connection.query = function (...args: unknown[]) {
    const first = args[0] as string | { text?: string };
    statements.push(typeof first === "string" ? first : first.text ?? "");
    return Reflect.apply(original, connection, args);
  } as typeof original;
});
beforeAll(() => runMigrations(database));
afterAll(() => client.pool.end());
beforeEach(async () => {
  await database.delete(schema.loginAttempts);
  statements = [];
});

it("enforces three different windows with at most five statements inside its transaction", async () => {
  const reserved = await reserveRateLimits([
    { key: "email", limit: { max: 3, windowMs: 60_000 } },
    { key: "ip", limit: { max: 30, windowMs: 900_000 } },
    { key: "pair", limit: { max: 5, windowMs: 900_000 } },
  ]);
  expect(reserved).toHaveLength(3);
  const work = statements.filter(statement => !/^(begin|commit)$/i.test(statement));
  expect(work.length).toBeLessThanOrEqual(5);
  expect((await database.select().from(schema.loginAttempts)).map(row => row.key).sort()).toEqual(["email", "ip", "pair"]);
});

it("counts only each key's own window, and a full quota blocks the whole reservation", async () => {
  const now = new Date();
  await database.insert(schema.loginAttempts).values([
    { key: "short", at: new Date(now.getTime() - 120_000) },
    { key: "long", at: new Date(now.getTime() - 120_000) },
  ]);
  expect(await reserveRateLimits([
    { key: "short", limit: { max: 1, windowMs: 60_000 } },
    { key: "long", limit: { max: 1, windowMs: 900_000 } },
  ], now)).toBeNull();
  expect(await database.select().from(schema.loginAttempts)).toHaveLength(2);
  expect(await reserveRateLimits([{ key: "short", limit: { max: 1, windowMs: 60_000 } }], now)).toHaveLength(1);
});

it('admits exactly the limit under concurrent requests, irrespective of key ordering', async () => {
  const limit = { max: 5, windowMs: 60000 };
  const results = await Promise.all(Array.from({ length: 25 }, (_, n) =>
    consumeRateLimit(n % 2 ? ['link', 'address'] : ['address', 'link'], limit)));
  expect(results.filter(Boolean)).toHaveLength(5);
  const attempts = await database.select().from(schema.loginAttempts);
  expect(attempts.filter(row => row.key === 'link')).toHaveLength(5);
  expect(attempts.filter(row => row.key === 'address')).toHaveLength(5);
});

it('does not charge other keys when one is full and permits requests after the window', async () => {
  const now = new Date('2026-09-20T12:00:00Z');
  const limit = { max: 1, windowMs: 60000 };
  expect(await consumeRateLimit(['full'], limit, now)).toBe(true);
  expect(await consumeRateLimit(['fresh', 'full'], limit, now)).toBe(false);
  expect(await consumeRateLimit(['fresh', 'fresh'], limit, now)).toBe(true);
  expect(await consumeRateLimit(['full'], limit, new Date(now.getTime() + 60001))).toBe(true);
});

it('applies different limits atomically and can release only this request reservations', async () => {
  const strict = { max: 1, windowMs: 60000 };
  const generous = { max: 3, windowMs: 60000 };
  const first = await reserveRateLimits([
    { key: 'email', limit: strict },
    { key: 'address', limit: generous },
  ]);
  expect(first).not.toBeNull();
  expect(await reserveRateLimits([
    { key: 'email', limit: strict },
    { key: 'address', limit: generous },
  ])).toBeNull();

  await database.insert(schema.loginAttempts).values({ key: 'address' });
  await releaseRateLimitReservations(first!.filter(row => row.key === 'address'));
  const addressRows = (await database.select().from(schema.loginAttempts)).filter(row => row.key === 'address');
  expect(addressRows).toHaveLength(1);
  expect((await database.select().from(schema.loginAttempts)).filter(row => row.key === 'email')).toHaveLength(1);
});
