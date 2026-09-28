"use client";
import { useEffect, useTransition, type DependencyList } from "react";
import { useRouter } from "next/navigation";

/** A reading that outlives this is abandoned: the next one will be fresher. */
const ABORT_MS = 8000;

/** What one reading decides: the wait before the next, null to stop, or "resync" to read again at once, whole. */
export type PollNext = number | null | "resync";

export interface VisiblePoll {
  /** When the first reading is taken: a delay, or "now". */
  first: number | "now";
  /**
   * One reading. `signal` aborts after eight seconds or when the poller is torn down; `alive()` is
   * false once it has been, and a reading that finds so should do nothing more. `resync` is true for
   * the reading a "resync" answer asked for.
   */
  read: (signal: AbortSignal, alive: () => boolean, resync: boolean) => Promise<PollNext>;
  /** A reading that threw (refused, dropped, aborted): the wait before the next one, or null to stop. */
  fail: () => number | null;
  /**
   * Stop asking after this long. It is time someone was looking: the time a hidden tab spent parked
   * is given back when it is looked at again.
   */
  ceilingMs?: number;
}

/**
 * The one poll loop the interface's live pages share. It asks nothing of a hidden tab — the tick
 * that finds it hidden parks, and the tab is asked at once when it is looked at again — aborts a
 * request that outlives its usefulness, and tears everything down on unmount or when `deps`
 * change. What a reading means, and how long to wait after it, is the caller's: `setup` runs once
 * per effect and returns the loop's decisions, or null when there is nothing to watch.
 */
export function useVisiblePoll(setup: () => VisiblePoll | null, deps: DependencyList): void {
  useEffect(() => {
    const loop = setup();
    if (!loop) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let until = loop.ceilingMs === undefined ? Infinity : Date.now() + loop.ceilingMs;
    let parkedAt: number | null = null;
    const alive = () => !cancelled;

    async function poll(resync = false) {
      timer = undefined;
      if (cancelled) return;
      if (document.visibilityState !== "visible") {
        parkedAt = Date.now();
        return;
      }
      let next: PollNext;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), ABORT_MS);
      try {
        next = await loop!.read(controller.signal, alive, resync);
      } catch {
        next = cancelled ? null : loop!.fail();
      } finally {
        clearTimeout(timeout);
      }
      if (cancelled || next === null) return;
      if (next === "resync") timer = setTimeout(() => void poll(true), 0);
      else if (Date.now() < until) timer = setTimeout(() => void poll(), next);
    }
    function onVisibility() {
      if (parkedAt === null || document.visibilityState !== "visible") return;
      until += Date.now() - parkedAt;
      parkedAt = null;
      void poll();
    }

    document.addEventListener("visibilitychange", onVisibility);
    if (loop.first === "now") void poll();
    else timer = setTimeout(() => void poll(), loop.first);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // The caller names what the loop depends on, as for any effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** First interval of a signature poll, and how long it keeps asking. */
const SIGNATURE_FIRST_MS = 5000;
const SIGNATURE_CEILING_MS = 10 * 60 * 1000;

/**
 * Watch a small status route for a signature and refresh the page when it moves (or `moved` says
 * the page is behind). The refresh goes through a transition, so an editor above is re-rendered
 * rather than remounted and unsaved text stays on the screen. It backs off by half again while
 * nothing changes, up to `longestMs`, and gives up after ten minutes of someone looking: a worker
 * that is not running must not leave a browser asking for ever.
 */
export function useSignatureRefresh<B extends { signature: string }>(
  { enabled, url, signature, longestMs, moved = () => false }: { enabled: boolean; url: string; signature: string; longestMs: number; moved?: (body: B) => boolean },
  deps: DependencyList,
): void {
  const router = useRouter();
  const [, startTransition] = useTransition();
  useVisiblePoll(() => {
    if (!enabled) return null;
    let current = signature;
    let wait = SIGNATURE_FIRST_MS;
    // A refused or dropped poll is not news either; wait a little longer and ask again.
    const backoff = () => (wait = Math.min(longestMs, Math.round(wait * 1.5)));
    return {
      first: SIGNATURE_FIRST_MS,
      ceilingMs: SIGNATURE_CEILING_MS,
      fail: backoff,
      async read(signal, alive) {
        const response = await fetch(url, { cache: "no-store", signal });
        if (!response.ok) throw new Error("Status unavailable");
        const result = (await response.json()) as B;
        if (!alive()) return null;
        if (result.signature === current && !moved(result)) return backoff();
        current = result.signature;
        wait = SIGNATURE_FIRST_MS;
        startTransition(() => router.refresh());
        return wait;
      },
    };
  }, [router, ...deps]);
}
