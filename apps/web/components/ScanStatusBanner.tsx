"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
export function ScanStatusBanner({ initialText }: { initialText: string }) {
  const [text, setText] = useState(initialText);
  const [stale, setStale] = useState(false);
  useEffect(() => setText(initialText), [initialText]);
  useEffect(() => {
    const controller = new AbortController();
    async function refresh() {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch("/api/scan-status", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Status unavailable");
        const value = await response.json() as { text: string };
        if (!controller.signal.aborted) { setText(value.text); setStale(false); }
      } catch { if (!controller.signal.aborted) setStale(true); }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    document.addEventListener("visibilitychange", refresh);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  return <Link href="/health" className="underline decoration-dotted"
    title="This batch only: newly stored matching vacancies, not your review queue. Individual company refreshes are separate. Open scan history for details.">
    {text}{stale && " · Live update unavailable"}
  </Link>;
}
