"use client";

import { useEffect, useState } from "react";
import { formatStepDuration } from "@/lib/format";

/**
 * A figure that keeps moving while a step is open: "40 s", "2 min 10 s".
 *
 * The page it sits on already refreshes itself while work is in flight (`AutoRefresh`), but that
 * poll is ten seconds apart, and a wait nobody can see moving reads as a wait nothing is happening
 * in. The first client render uses the server's own figure, so hydration matches; the interval
 * starts after it and is cleared when the step closes and the server stops rendering this.
 */
export function ElapsedTime({ sinceMs, initialMs }: { sinceMs: number; initialMs: number }) {
  const [ms, setMs] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setMs(Math.max(0, Date.now() - sinceMs));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [sinceMs]);
  return <>{formatStepDuration(ms ?? initialMs)}</>;
}
