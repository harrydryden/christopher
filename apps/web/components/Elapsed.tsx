"use client";

import { useEffect, useState } from "react";
import { formatStepDuration, relativeTime } from "@/lib/format";

/**
 * Text that keeps counting from a moment: "46 s", "2 min 10 s" — or, as `relative`, "3m ago".
 *
 * Elapsed figures used to move only because the page re-rendered itself on the server at least once
 * a minute; this moves them in the browser instead, and nothing else. The first render uses the
 * server's `now`, so hydration matches; the clock starts after it, corrected by how far the
 * browser's clock was from the server's at mount, so a skewed clock neither reads "0 s" for ever
 * nor starts minutes in.
 */
export function Elapsed({ since, now, relative = false }: { since: string | number | Date; now: number; relative?: boolean }) {
  const start = typeof since === "number" ? since : new Date(since).getTime();
  const [at, setAt] = useState(now);
  const [skew] = useState(() => now - Date.now());
  useEffect(() => {
    const tick = () => setAt(Date.now() + skew);
    tick();
    const timer = setInterval(tick, relative ? 15_000 : 1_000);
    return () => clearInterval(timer);
  }, [relative, skew]);
  return <>{relative ? relativeTime(new Date(start), new Date(at)) : formatStepDuration(Math.max(0, at - start))}</>;
}
