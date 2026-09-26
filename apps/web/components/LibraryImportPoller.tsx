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
 * Modelled on `LibraryEvidencePoller`: each tick asks `/api/cv/library/imports` how the imports
 * in flight stand (one small aggregate), and the page is refreshed only when that has moved, not
 * on every tick. `signature` is what the page saw when it rendered; `pending` is how many it
 * showed as reading, so an answer reporting fewer means the page is behind even if the
 * fingerprint was read after the import landed.
 *
 * It refreshes through a transition so the editor above is re-rendered rather than remounted and
 * unsaved text stays on the screen. It asks nothing of a hidden tab, aborts a request that
 * outlives its usefulness, backs off while nothing changes, and gives up after ten minutes: a
 * worker that is not running must not leave a browser asking for ever. The page mounts this only
 * while something is being read, so the refresh that lands the proposal also unmounts it.
 */
export function LibraryImportPoller({ pending, signature }: { pending: number; signature: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  useEffect(() => {
    if (pending < 1) return;
    let cancelled = false;
    let current = signature;
    let wait = FIRST_MS;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    const until = Date.now() + CEILING_MS;

    async function poll() {
      if (cancelled) return;
      if (document.visibilityState === "visible") {
        controller = new AbortController();
        const timeout = setTimeout(() => controller?.abort(), 8000);
        try {
          const response = await fetch("/api/cv/library/imports", { cache: "no-store", signal: controller.signal });
          if (!response.ok) throw new Error("Import status unavailable");
          const result = (await response.json()) as { reading: number; signature: string };
          if (cancelled) return;
          if (result.signature !== current || result.reading < pending) {
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
      }
      if (!cancelled && Date.now() < until) timer = setTimeout(poll, wait);
    }

    timer = setTimeout(poll, FIRST_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [router, pending, signature]);
  return null;
}
