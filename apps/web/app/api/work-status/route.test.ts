import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ current: null as null | { user: { id: string } } }));
vi.mock('@/lib/auth', () => ({ requireUser: vi.fn(async () => { if (!mocks.current) throw new Error('Unauthorised'); return mocks.current.user; }) }));
vi.mock('@/lib/work-status', () => ({
  getAccountWorkStatus: vi.fn(async () => ({ active: false, version: 'idle' })),
  getCompanyWorkStatus: vi.fn(async () => ({ active: true, version: 'companies' })),
  getCvWorkStatus: vi.fn(async () => ({ active: true, version: 'cvs' })),
}));
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

  it('answers for the half a page asked about, so it compares the version it rendered', async () => {
    mocks.current = { user: { id: '00000000-0000-4000-8000-000000000001' } };
    const companies = await GET(new Request('http://localhost/api/work-status?scope=company'));
    await expect(companies.json()).resolves.toEqual({ active: true, version: 'companies' });
    expect(companies.headers.get('cache-control')).toContain('no-store');
    const cvs = await GET(new Request('http://localhost/api/work-status?scope=cv'));
    await expect(cvs.json()).resolves.toEqual({ active: true, version: 'cvs' });
    const { getCompanyWorkStatus, getCvWorkStatus } = await import('@/lib/work-status');
    expect(getCompanyWorkStatus).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
    expect(getCvWorkStatus).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
  });

  it('refuses a scope it does not know', async () => {
    mocks.current = { user: { id: '00000000-0000-4000-8000-000000000001' } };
    const response = await GET(new Request('http://localhost/api/work-status?scope=everything'));
    expect(response.status).toBe(400);
  });
});
