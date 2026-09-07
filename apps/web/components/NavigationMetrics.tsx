"use client";
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
export function NavigationMetrics() {
  const path = usePathname();
  const started = useRef<number | null>(null);
  useEffect(() => {
    const click = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest('a') : null;
      if (anchor && anchor.origin === location.origin && anchor.pathname !== location.pathname && !event.metaKey && !event.ctrlKey) started.current = performance.now();
    };
    document.addEventListener('click', click, true);
    return () => document.removeEventListener('click', click, true);
  }, []);
  useEffect(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const durationMs = started.current === null ? navigation?.responseEnd : performance.now() - started.current;
    started.current = null;
    if (durationMs !== undefined) navigator.sendBeacon('/api/performance', JSON.stringify({ path: path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id'), durationMs }));
  }, [path]);
  return null;
}
