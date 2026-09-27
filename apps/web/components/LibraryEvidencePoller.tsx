"use client";
import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";

/** First interval, and the ceiling it backs off to while nothing lands. */
const FIRST_MS = 5000;
const LONGEST_MS = 30000;
/** How long to keep asking. A pass has four minutes; this outlasts it and then stops. */
const CEILING_MS = 10 * 60 * 1000;

/**
 * Watch one saved Library version's evidence reviews and refresh the page when they move.
 *
 * Modelled on `AutoRefresh`, with the same three manners: it asks nothing of a hidden tab, it
 * aborts a request that outlives its usefulness, and it refreshes through a transition so the
 * editor above it is re-rendered rather than remounted — which is what keeps unsaved text on the
 * screen while a score arrives underneath it.
 *
 * It backs off while nothing changes, because the baseline lands in seconds and the model's review
 * in minutes, and it gives up after ten of them: a worker that is not running must not leave a
 * browser asking forever. The page mounts it only while something is still being evaluated, so
 * the refresh that lands the last review also unmounts the poller.
 */
export function LibraryEvidencePoller({ version, signature }: { version: number; signature: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  useEffect(() => {
    if (!Number.isInteger(version) || version < 1) return;
    let cancelled = false;
    let current = signature;
    let wait = FIRST_MS;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    let until = Date.now() + CEILING_MS;
    // When a tick found the tab hidden and stopped, as `AutoRefresh` parks: the ceiling is ten
    // minutes of someone looking, so the time away is given back and the tab is asked at once on
    // return, rather than a score that landed while the tab was away never reaching the page.
    let parkedAt: number | null = null;

    async function poll() {
      if (cancelled) return;
      if (document.visibilityState !== "visible") {
        parkedAt = Date.now();
        return;
      }
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 8000);
      try {
        const response = await fetch(`/api/cv/library/reviews?version=${version}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Reviews unavailable");
        const result = (await response.json()) as { signature: string };
        if (cancelled) return;
        if (result.signature !== current) {
          current = result.signature;
          wait = FIRST_MS;
          startTransition(() => router.refresh());
        } else {
          wait = Math.min(LONGEST_MS, Math.round(wait * 1.5));
        }
      } catch {
        /* A refused or dropped poll is not news; wait a little longer and ask again. */
        wait = Math.min(LONGEST_MS, Math.round(wait * 1.5));
      } finally {
        clearTimeout(timeout);
      }
      if (!cancelled && Date.now() < until) timer = setTimeout(poll, wait);
    }
    function onVisibility() {
      if (parkedAt === null || document.visibilityState !== "visible") return;
      until += Date.now() - parkedAt;
      parkedAt = null;
      void poll();
    }

    document.addEventListener("visibilitychange", onVisibility);
    timer = setTimeout(poll, FIRST_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router, version, signature]);
  return null;
}
