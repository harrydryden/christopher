import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ current: null as null | { user: { id: string } } }));
vi.mock('@/lib/auth', () => ({ requireUser: vi.fn(async () => { if (!mocks.current) throw new Error('Unauthorised'); return mocks.current.user; }) }));
vi.mock('@/lib/work-status', () => ({ getAccountWorkStatus: vi.fn(async () => ({ active: false, version: 'idle' })) }));
vi.mock('@/lib/queries/cv', () => ({ getOwnCvWorkRow: vi.fn(), cvWorkVersionFor: vi.fn() }));

import { GET } from './route';

describe('GET /api/work-status authentication', () => {
  beforeEach(() => { mocks.current = null; });

  it('returns JSON 401 when a cookie has no live database session', async () => {
    const response = await GET(new Request('http://localhost/api/work-status'));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toContain('no-store');
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'Please sign in again.' });
  });

  it('serves the account status for a live session', async () => {
    mocks.current = { user: { id: '00000000-0000-4000-8000-000000000001' } };
    const response = await GET(new Request('http://localhost/api/work-status'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ active: false, version: 'idle' });
  });
});
