import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const jar = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => (jar.value ? { value: jar.value } : undefined) }) }));
// The beacon must never cost a database round trip: any read at all fails the test.
vi.mock('@/lib/db', () => ({ db: () => { throw new Error('the beacon read the database'); } }));

import { createSessionCookieValue } from '@/lib/session';
import { POST } from './route';

const SECRET = 'performance-route-test-secret-0123456789';
const beacon = (body: unknown) => POST(new Request('http://localhost/api/performance', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));

describe('POST /api/performance', () => {
  beforeEach(() => { vi.stubEnv('SESSION_SECRET', SECRET); jar.value = undefined; });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('logs a navigation for a validly signed cookie without reading the database', async () => {
    jar.value = await createSessionCookieValue(SECRET, crypto.randomUUID(), new Date(Date.now() + 60_000));
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const response = await beacon({ path: '/companies/:id', durationMs: 412.6 });
    expect(response.status).toBe(204);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ event: 'page_navigation', path: '/companies/:id', durationMs: 413 });
  });

  it('refuses a missing, forged or expired cookie', async () => {
    expect((await beacon({ path: '/', durationMs: 1 })).status).toBe(401);
    jar.value = await createSessionCookieValue('another-secret-entirely-0123456789abcdef', crypto.randomUUID(), new Date(Date.now() + 60_000));
    expect((await beacon({ path: '/', durationMs: 1 })).status).toBe(401);
    jar.value = await createSessionCookieValue(SECRET, crypto.randomUUID(), new Date(Date.now() - 1_000));
    const refused = await beacon({ path: '/', durationMs: 1 });
    expect(refused.status).toBe(401);
    expect(refused.headers.get('cache-control')).toContain('no-store');
  });

  it('still bounds what it accepts', async () => {
    jar.value = await createSessionCookieValue(SECRET, crypto.randomUUID(), new Date(Date.now() + 60_000));
    expect((await beacon('x'.repeat(1001))).status).toBe(413);
    expect((await beacon({ path: 'https://evil.example', durationMs: 1 })).status).toBe(400);
    expect((await beacon('not json')).status).toBe(400);
  });
});
