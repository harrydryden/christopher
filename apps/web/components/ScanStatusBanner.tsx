"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { BANNER_FAILURES, BANNER_FIRST_MS, BANNER_RECHECK_MS, bannerPollDelay, nextPollDelay, LONGEST_POLL_MS, type ScanPollHint } from "@/lib/polling";

/**
 * The shared run's line for this account. It asks for a fresh line only while a run is in progress
 * or due within the hour, waits longer each time the line comes back unchanged, and asks nothing of
 * a hidden tab. Otherwise it sleeps until the server says the next run is close, so an open tab
 * costs a request or two a day between runs rather than one every half minute.
 */
export function ScanStatusBanner({ initialText, initialLive, initialWakeInMs }: { initialText: string; initialLive: boolean; initialWakeInMs: number | null }) {
  const [text, setText] = useState(initialText);
  const [stale, setStale] = useState(false);
  useEffect(() => setText(initialText), [initialText]);
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let parked = false;
    let busy = false;
    let live = initialLive;
    let readAt = Date.now();
    let last = initialText;
    let wait = BANNER_FIRST_MS;
    let failures = 0;

    function plan(hint: ScanPollHint) {
      const delay = bannerPollDelay(hint, wait);
      if (delay === null || cancelled) return;
      // Tabs that slept until the same moment spread their wake-ups over a minute.
      timer = setTimeout(refresh, hint.live ? delay : delay + 1000 + Math.floor(Math.random() * 59_000));
    }

    async function refresh() {
      timer = undefined;
      if (cancelled || busy) return;
      if (document.visibilityState !== "visible") {
        parked = true;
        return;
      }
      busy = true;
      try {
        const response = await fetch("/api/scan-status", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Status unavailable");
        const value = (await response.json()) as { text: string } & ScanPollHint;
        if (cancelled) return;
        setText(value.text);
        setStale(false);
        failures = 0;
        readAt = Date.now();
        live = value.live;
        wait = nextPollDelay(wait, value.text !== last, BANNER_FIRST_MS, LONGEST_POLL_MS);
        last = value.text;
        plan(value);
      } catch {
        if (cancelled) return;
        setStale(true);
        failures += 1;
        wait = nextPollDelay(wait, false, BANNER_FIRST_MS, LONGEST_POLL_MS);
        if (failures < BANNER_FAILURES) plan({ live: true, wakeInMs: null });
      } finally {
        busy = false;
      }
    }

    function onVisibility() {
      if (document.visibilityState !== "visible" || busy) return;
      if (parked || (!live && Date.now() - readAt >= BANNER_RECHECK_MS)) {
        parked = false;
        clearTimeout(timer);
        void refresh();
      }
    }

    plan({ live: initialLive, wakeInMs: initialWakeInMs });
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [initialText, initialLive, initialWakeInMs]);
  return <Link prefetch={false} href="/health" className="text-13 underline decoration-dotted"
    title="This batch only: newly stored matching vacancies, not your review queue. Individual company refreshes are separate. Open scan history for details.">
    {text}{stale && " · Live update unavailable"}
  </Link>;
}
