import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { runMigrations } from '@ava/db/migrate';
import type { Db } from '@ava/db';
import { createTestDb } from '@/test/db';

const jar = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => (jar.value ? { value: jar.value } : undefined) }) }));
const store = vi.hoisted(() => ({ database: undefined as unknown, reads: 0 }));
vi.mock('@/lib/db', () => ({ db: () => { store.reads++; return store.database; } }));

import { createSessionCookieValue } from '@/lib/session';
import { vitalBucket } from '@/lib/web-vitals';
import { POST } from './route';

const SECRET = 'performance-route-test-secret-0123456789';
const beacon = (body: unknown) => POST(new Request('http://localhost/api/performance', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
const report = (overrides: Record<string, unknown> = {}) => ({ route: '/companies/:id', metric: 'LCP', value: 1_840, rating: 'good', navType: 'navigate', deviceClass: 'high', effectiveType: '4g', ...overrides });

let database: Db;
let pool: ReturnType<typeof createTestDb>['pool'];
beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  store.database = database;
  await runMigrations(database);
});
afterAll(() => pool.end());

async function histogram() {
  const rows = await database.execute<{ day: string; route: string; metric: string; bucket: number; count: number }>(
    sql`select day::text as day, route, metric, bucket, count from web_vitals order by metric, bucket`);
  return rows.rows;
}

describe('POST /api/performance', () => {
  beforeEach(async () => {
    vi.stubEnv('SESSION_SECRET', SECRET);
    jar.value = await createSessionCookieValue(SECRET, crypto.randomUUID(), new Date(Date.now() + 60_000));
    store.reads = 0;
    await database.execute(sql`truncate web_vitals`);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('adds a page load\'s vitals to the day\'s histograms, and a second load to the same buckets', async () => {
    const load = [report(), report({ metric: 'CLS', value: 0.04 }), report({ metric: 'INP', value: 120, rating: 'good' })];
    expect((await beacon(load)).status).toBe(204);
    expect((await beacon(load)).status).toBe(204);
    const today = new Date().toISOString().slice(0, 10);
    expect(await histogram()).toEqual([
      { day: today, route: '/companies/:id', metric: 'CLS', bucket: vitalBucket('CLS', 0.04), count: 2 },
      { day: today, route: '/companies/:id', metric: 'INP', bucket: vitalBucket('INP', 120), count: 2 },
      { day: today, route: '/companies/:id', metric: 'LCP', bucket: vitalBucket('LCP', 1_840), count: 2 },
    ]);
  });

  it('refuses a missing, forged or expired cookie without touching the database', async () => {
    jar.value = undefined;
    expect((await beacon([report()])).status).toBe(401);
    jar.value = await createSessionCookieValue('another-secret-entirely-0123456789abcdef', crypto.randomUUID(), new Date(Date.now() + 60_000));
    expect((await beacon([report()])).status).toBe(401);
    jar.value = await createSessionCookieValue(SECRET, crypto.randomUUID(), new Date(Date.now() - 1_000));
    const refused = await beacon([report()]);
    expect(refused.status).toBe(401);
    expect(refused.headers.get('cache-control')).toContain('no-store');
    expect(store.reads).toBe(0);
  });

  it('refuses any key beyond the seven it defines, so nothing identifying can ride along', async () => {
    for (const extra of [{ userId: crypto.randomUUID() }, { sessionId: 'x' }, { email: 'a@b.c' }, { url: 'https://ava.example/?view=x' }, { id: 'v5-123' }]) {
      expect((await beacon([report(extra)])).status, JSON.stringify(extra)).toBe(400);
    }
    // The old navigation beacon's shape is gone too.
    expect((await beacon({ path: '/companies/:id', durationMs: 412 })).status).toBe(400);
    expect(await histogram()).toEqual([]);
    expect(store.reads).toBe(0);
  });

  it('refuses a missing key, a bad value, a raw id in the route, a query string and a repeated metric', async () => {
    const { rating: _dropped, ...missing } = report();
    for (const body of [
      [missing],
      [report({ metric: 'FID' })],
      [report({ value: -1 })],
      [report({ value: Number.MAX_SAFE_INTEGER })],
      [report({ rating: 'great' })],
      [report({ route: `/companies/${crypto.randomUUID()}` })],
      [report({ route: '/?view=auto-matched' })],
      [report({ route: 'https://evil.example' })],
      [report(), report()],
      [],
      'not json',
    ]) expect((await beacon(body)).status, JSON.stringify(body)).toBe(400);
    expect((await beacon('x'.repeat(2_001))).status).toBe(413);
    expect(await histogram()).toEqual([]);
  });

  it('answers 204 even when the write fails', async () => {
    store.database = { execute: async () => { throw new Error('database unavailable'); } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await beacon([report()])).status).toBe(204);
      expect(JSON.parse(warn.mock.calls[0]![0] as string)).toMatchObject({ event: 'web_vitals_write_failed' });
    } finally {
      store.database = database;
    }
  });
});
