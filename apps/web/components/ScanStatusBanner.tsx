"use client";
import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { BANNER_FAILURES, BANNER_FIRST_MS, BANNER_RECHECK_MS, bannerPollDelay, nextPollDelay, LONGEST_POLL_MS, type ScanPollHint } from "@/lib/polling";
import { scanStripItems, scanStripSignature, type ScanStripFacts } from "@/lib/scan-banner";

type Reading = ScanStripFacts & ScanPollHint;

const MINUTE_MS = 60_000;

/**
 * The status strip: last scan, companies followed, new role matches, new company matches, each
 * linking to the page that holds what it counts, with "Scanning" in front while the shared run is
 * in progress.
 *
 * It asks for a fresh reading only while a run is in progress or due within the hour, waits longer
 * each time the reading comes back unchanged, and asks nothing of a hidden tab. Otherwise it sleeps
 * until the server says the next run is close, so an open tab costs a request or two a day between
 * runs rather than one every half minute. "2h ago" is worked out here against the tab's own clock
 * once a minute, which costs no request.
 */
export function ScanStatusBanner({ initial }: { initial: Reading }) {
  const [facts, setFacts] = useState<ScanStripFacts>(initial);
  const [stale, setStale] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const initialSignature = scanStripSignature(initial);
  const { live: initialLive, wakeInMs: initialWakeInMs } = initial;
  // A fresh server render (after an action revalidates the layout) replaces what the tab last read.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setFacts(initial), [initialSignature]);
  useEffect(() => {
    const tick = setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, MINUTE_MS);
    return () => clearInterval(tick);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let parked = false;
    let busy = false;
    let live = initialLive;
    let readAt = Date.now();
    let last = initialSignature;
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
        const value = (await response.json()) as Reading;
        if (cancelled) return;
        const signature = scanStripSignature(value);
        setFacts(value);
        setNow(Date.now());
        setStale(false);
        failures = 0;
        readAt = Date.now();
        live = value.live;
        wait = nextPollDelay(wait, signature !== last, BANNER_FIRST_MS, LONGEST_POLL_MS);
        last = signature;
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
      setNow(Date.now());
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
  }, [initialSignature, initialLive, initialWakeInMs]);

  const items = scanStripItems(facts, new Date(now));
  return (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-13">
      {facts.scanning && <span className="ds-pixel text-10" role="status">Scanning now</span>}
      {items.map((item, index) => (
        <Fragment key={item.key}>
          {(index > 0 || facts.scanning) && <span className="text-muted" aria-hidden="true">·</span>}
          <Link prefetch={false} href={item.href} title={item.title} className="underline decoration-dotted" suppressHydrationWarning={item.key === "last-scan"}>
            {item.text}
          </Link>
        </Fragment>
      ))}
      {stale && <span className="text-muted">· Live update unavailable</span>}
    </p>
  );
}
