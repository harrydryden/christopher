import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createDb, schema, type Db } from '@ava/db';
import { createTestDb } from "@/test/db";
import { runMigrations } from '@ava/db/migrate';
import { sql } from 'drizzle-orm';

let database: Db;
let pool: ReturnType<typeof createDb>['pool'];
vi.mock('@/lib/db', () => ({ db: () => database }));
import { consumeRateLimit, releaseRateLimitReservations, reserveRateLimits } from './rate-limit';

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
beforeEach(async () => { await database.execute(sql`truncate login_attempts`); });
afterAll(async () => { await pool.end(); });

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
