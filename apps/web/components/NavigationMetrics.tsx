"use client";
import { useEffect } from 'react';
import { VITALS_SAMPLE_RATE } from '@/lib/web-vitals';

let sampled = false;

/** Test only: let another simulated page load decide whether to sample. */
export function resetNavigationSamplingForTests() {
  sampled = false;
}

/** Keep the field observer outside every route's first load. Most loads never need it. */
export function beginNavigationMetrics(random: () => number = Math.random) {
  if (sampled) return;
  sampled = true;
  if (/Chrome-Lighthouse|HeadlessChrome/.test(navigator.userAgent) || random() >= VITALS_SAMPLE_RATE) return;
  void import('./navigation-vitals').then(({ startVitals }) => startVitals(() => 0)).catch(() => {});
}

export function NavigationMetrics() {
  useEffect(() => { beginNavigationMetrics(); }, []);
  return null;
}
