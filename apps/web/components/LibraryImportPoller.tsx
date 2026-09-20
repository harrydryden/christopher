"use client";
import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";

/** First interval, and the ceiling it backs off to while the worker is still reading. */
const FIRST_MS = 5000;
const LONGEST_MS = 20000;
/** How long to keep asking. The task has four minutes; this outlasts it and then stops. */
const CEILING_MS = 10 * 60 * 1000;

/**
 * Watch for a document that is still being read, and refresh the page when it lands.
 *
 * It refreshes through a transition, as `LibraryEvidencePoller` does, so the editor above is
 * re-rendered rather than remounted and unsaved text stays on the screen. It asks nothing of a
 * hidden tab, backs off while nothing changes, and gives up after ten minutes: a worker that is
 * not running must not leave a browser asking for ever.
 *
 * It refreshes the page rather than polling a status endpoint, because the page render is what
 * knows whether an import has been answered — one small query per refresh, and only while
 * something is actually being read. The page mounts this only then, so the refresh that lands the
 * proposal is also the one that unmounts the poller.
 */
export function LibraryImportPoller({ pending }: { pending: number }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  useEffect(() => {
    if (pending < 1) return;
    let cancelled = false;
    let wait = FIRST_MS;
    let timer: ReturnType<typeof setTimeout>;
    const until = Date.now() + CEILING_MS;

    const tick = () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") {
        startTransition(() => router.refresh());
        wait = Math.min(LONGEST_MS, Math.round(wait * 1.5));
      }
      if (!cancelled && Date.now() < until) timer = setTimeout(tick, wait);
    };

    timer = setTimeout(tick, FIRST_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [router, pending]);
  return null;
}
