"use client";
import { useEffect } from 'react';
import type { Metric } from 'web-vitals';
import { VITAL_ROUTES, vitalRoute, VITALS_SAMPLE_RATE, type VitalReport } from '@/lib/web-vitals';

/**
 * Real-user Core Web Vitals for one page load in four, sent once. The load is sampled when this
 * module first runs in the browser, and only a sampled load downloads the library: it is a chunk of
 * its own, about 3 KB gzip that the other three loads in four never fetch, and its observers read
 * the browser's buffered entries, so loading it after hydration loses nothing it reports. A sampled
 * load watches LCP, INP, CLS, TTFB and FCP, keeps each metric's latest value, and when the page is
 * hidden sends every metric it has not sent yet in one beacon. A metric is sent at most once per
 * load, so a tab hidden twice is not counted twice.
 *
 * The payload is `lib/web-vitals.ts`'s seven keys and nothing else: the landing route with ids
 * replaced by `:id`, no query string, no account, session or address. The route refuses anything more.
 */
type Pending = Omit<VitalReport, 'route' | 'deviceClass' | 'effectiveType'>;

let started = false;

const LAB_BROWSER = /Chrome-Lighthouse|HeadlessChrome/;

function deviceClass(): VitalReport['deviceClass'] {
  return (navigator.hardwareConcurrency ?? 0) <= 4 ? 'low' : 'high';
}

function effectiveType(): VitalReport['effectiveType'] {
  const type = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection?.effectiveType;
  return type === 'slow-2g' || type === '2g' || type === '3g' || type === '4g' ? type : 'unknown';
}

/** Starts the watch for this load if it is sampled; true once it is watching. Exported for the component test. */
export async function startVitals(random: () => number = Math.random): Promise<boolean> {
  if (started) return false;
  started = true;
  // Lab browsers are not users: Lighthouse and the headless smoke runs would put their numbers in
  // the field data, and a sampled lab run would download the library and move the lab's own totals.
  if (LAB_BROWSER.test(navigator.userAgent)) return false;
  // A page the route would refuse (sign-up, a 404) is not watched: its beacon could only be a 400.
  const route = vitalRoute(location.pathname);
  if (!VITAL_ROUTES.has(route)) return false;
  if (random() >= VITALS_SAMPLE_RATE) return false;
  let library: typeof import('web-vitals');
  try { library = await import('web-vitals'); } catch { return false; }
  const { onCLS, onFCP, onINP, onLCP, onTTFB } = library;
  const latest = new Map<Metric['name'], Pending>();
  const sent = new Set<Metric['name']>();
  const record = (metric: Metric) => {
    if (sent.has(metric.name)) return;
    latest.set(metric.name, { metric: metric.name, value: metric.value, rating: metric.rating, navType: metric.navigationType });
  };
  onLCP(record);
  onINP(record);
  onCLS(record);
  onTTFB(record);
  onFCP(record);
  // On window, in the bubbling phase: web-vitals reports its final LCP, INP and CLS from a capturing
  // listener on the same event, which runs first, so those values are in `latest` by now.
  addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' || latest.size === 0) return;
    const device = deviceClass(), network = effectiveType();
    const batch: VitalReport[] = [...latest.values()].map((pending) => ({ route, ...pending, deviceClass: device, effectiveType: network }));
    for (const report of batch) sent.add(report.metric);
    latest.clear();
    navigator.sendBeacon('/api/performance', JSON.stringify(batch));
  });
  return true;
}

/** Test only: forget that this module has started, so a test can start it again. */
export function resetVitalsForTests(): void {
  started = false;
}

export function NavigationMetrics() {
  useEffect(() => { void startVitals(); }, []);
  return null;
}
