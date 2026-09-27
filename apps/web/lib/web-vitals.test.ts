import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { histogramP75, readVitalReport, readVitalsBeacon, VITAL_ROUTES, vitalBucket, vitalBucketValue, vitalRating, vitalRoute, formatVital } from './web-vitals';

const report = (overrides: Record<string, unknown> = {}) => ({ route: '/', metric: 'LCP', value: 1_200, rating: 'good', navType: 'navigate', deviceClass: 'low', effectiveType: '4g', ...overrides });

describe('vitalRoute', () => {
  it('turns every id-shaped segment into :id and drops the query and fragment', () => {
    expect(vitalRoute(`/companies/${crypto.randomUUID()}`)).toBe('/companies/:id');
    expect(vitalRoute(`/cv/${crypto.randomUUID()}?tab=log#top`)).toBe('/cv/:id');
    expect(vitalRoute('/share/AbCdEfGhIjKlMnOpQrStUvWx')).toBe('/share/:id');
    expect(vitalRoute('/?view=auto-matched')).toBe('/');
    expect(vitalRoute('/forgot-password')).toBe('/forgot-password');
    expect(vitalRoute('')).toBe('/');
  });
});

describe('VITAL_ROUTES', () => {
  it('is every page under app/(app), plus /login and /share/[token], each as the beacon names it', () => {
    const root = fileURLToPath(new URL('../app/', import.meta.url));
    const pages = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? pages(join(dir, entry.name)) : entry.name === 'page.tsx' ? [dir] : []);
    const asRoute = (dir: string) => '/' + relative(root, dir).split(sep).filter((part) => part && !/^\(.*\)$/.test(part))
      .map((part) => (/^\[.*\]$/.test(part) ? ':id' : part)).join('/');
    const expected = [...pages(join(root, '(app)')).map(asRoute), '/login', '/share/:id'].sort();
    expect([...VITAL_ROUTES].sort()).toEqual(expected);
    expect(readVitalReport(report({ route: '/wp-admin' }))).toBeNull();
    expect(readVitalReport(report({ route: '/companies/:id' }))).not.toBeNull();
  });
});

describe('readVitalReport and readVitalsBeacon', () => {
  it('accept exactly the seven keys with valid values', () => {
    expect(readVitalReport(report())).toEqual(report());
    expect(readVitalsBeacon(JSON.stringify([report(), report({ metric: 'CLS', value: 0.2, rating: 'needs-improvement' })]))).toHaveLength(2);
  });

  it('refuse an extra key, a missing key, and a route that is not already a route', () => {
    expect(readVitalReport({ ...report(), userId: 'x' })).toBeNull();
    const { navType: _n, ...missing } = report();
    expect(readVitalReport(missing)).toBeNull();
    expect(readVitalReport(report({ route: `/cv/${crypto.randomUUID()}` }))).toBeNull();
    expect(readVitalReport(report({ route: '/?q=1' }))).toBeNull();
    expect(readVitalReport(report({ value: '1200' }))).toBeNull();
    expect(readVitalReport(report({ metric: 'CLS', value: 101 }))).toBeNull();
    expect(readVitalReport([report()])).toBeNull();
  });

  it('refuse an empty beacon, more than one report per metric, more than five, and malformed JSON', () => {
    expect(readVitalsBeacon('[]')).toBeNull();
    expect(readVitalsBeacon(JSON.stringify([report(), report()]))).toBeNull();
    expect(readVitalsBeacon(JSON.stringify(['LCP', 'INP', 'CLS', 'TTFB', 'FCP', 'LCP'].map(metric => report({ metric }))))).toBeNull();
    expect(readVitalsBeacon('{')).toBeNull();
    expect(readVitalsBeacon(JSON.stringify(report()))).toBeNull();
  });
});

describe('buckets and the p75', () => {
  it('are log-scaled, eight to a doubling, so a value comes back within about 4.5 %', () => {
    for (const value of [1, 3, 45, 180, 800, 2_400, 9_999, 60_000]) {
      const back = vitalBucketValue('LCP', vitalBucket('LCP', value));
      expect(Math.abs(back - value) / value).toBeLessThan(0.045);
    }
    expect(vitalBucket('LCP', 0)).toBe(0);
    expect(vitalBucketValue('LCP', 0)).toBe(0);
    expect(vitalBucket('LCP', 2_000)).toBe(vitalBucket('LCP', 2_010));
    expect(vitalBucket('LCP', 2_000)).toBeLessThan(vitalBucket('LCP', 2_400));
    // CLS is scaled by a thousand before bucketing, so 0.05 and 0.1 fall apart.
    expect(vitalBucket('CLS', 0.05)).toBeLessThan(vitalBucket('CLS', 0.1));
    expect(Math.abs(vitalBucketValue('CLS', vitalBucket('CLS', 0.1)) - 0.1)).toBeLessThan(0.005);
  });

  it('reads the p75 from the bucket where the running count first reaches three quarters', () => {
    const rows = [100, 100, 100, 200, 200, 200, 300, 300, 400, 3_000, 3_000, 3_000].reduce((acc, value) => {
      const bucket = vitalBucket('INP', value);
      acc.set(bucket, (acc.get(bucket) ?? 0) + 1);
      return acc;
    }, new Map<number, number>());
    const p75 = histogramP75('INP', [...rows].map(([bucket, count]) => ({ bucket, count })));
    // Nine of twelve is the ninth value: 400 ms.
    expect(Math.abs(p75! - 400) / 400).toBeLessThan(0.045);
    expect(histogramP75('INP', [])).toBeNull();
    expect(histogramP75('INP', [{ bucket: 10, count: 0 }])).toBeNull();
  });

  it('rates and formats against the published boundaries', () => {
    expect(vitalRating('LCP', 2_500)).toBe('good');
    expect(vitalRating('LCP', 3_000)).toBe('needs-improvement');
    expect(vitalRating('CLS', 0.3)).toBe('poor');
    expect(formatVital('LCP', 2_430)).toBe('2.4 s');
    expect(formatVital('INP', 180.4)).toBe('180 ms');
    expect(formatVital('CLS', 0.083)).toBe('0.08');
  });
});
