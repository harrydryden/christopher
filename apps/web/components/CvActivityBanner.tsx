"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useVisiblePoll } from "./useVisiblePoll";
import { CV_ACTIVITY_STAGES, cvActivityLabel, cvActivityStage, isCvActive, type CvActivityReading } from "@/lib/cv-activity";

/** One account-wide reading; never refreshes or replaces the user's open editor. */
export function CvActivityBanner({ initial, children }: { initial: CvActivityReading[]; children: ReactNode }) {
  const pathname = usePathname();
  const [items, setItems] = useState(initial);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState("");
  const [dismissing, setDismissing] = useState(false);
  const seen = useRef(new Set(initial.map(item => item.id)));
  const acknowledged = useRef(new Set<string>());
  const initialActive = initial.find(isCvActive);
  const previousLabel = useRef(initialActive ? cvActivityLabel(initialActive) : undefined);
  const signature = JSON.stringify(initial);
  useEffect(() => { setItems(initial); }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  useVisiblePoll(() => {
    let failures = 0;
    return {
      first: "now",
      fail: () => { setError("Live update unavailable"); return Math.min(60_000, 5000 * 2 ** failures++); },
      async read(signal, alive) {
        const response = await fetch("/api/cv/activity", { cache: "no-store", signal });
        if (!response.ok) throw new Error("Activity unavailable");
        const next = await response.json() as CvActivityReading[];
        if (!alive()) return null;
        const fresh = next.filter(item => item.unread && !seen.current.has(item.id));
        const live = next.find(isCvActive);
        if (!fresh.length && live && cvActivityLabel(live) !== previousLabel.current) setAnnouncement(`${cvActivityLabel(live)}: ${live.company}, ${live.jobTitle}`);
        previousLabel.current = live ? cvActivityLabel(live) : undefined;
        if (fresh.length) setAnnouncement(fresh.map(item => `${cvActivityLabel(item)}: ${item.company}, ${item.jobTitle}`).join(". "));
        next.forEach(item => seen.current.add(item.id));
        setItems(next.filter(item => !acknowledged.current.has(item.id)));
        setError(""); failures = 0;
        return next.some(isCvActive) ? 5000 : 60_000;
      },
    };
  }, [pathname, signature]);
  const visible = items.filter(item => isCvActive(item) || item.unread);
  const item = visible.find(isCvActive) ?? visible[0];
  async function dismiss(id: string) {
    setDismissing(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch("/api/cv/activity", { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      if (!response.ok) throw new Error("Not saved");
      acknowledged.current.add(id);
      setItems(current => current.filter(entry => entry.id !== id));
      setError("");
    } catch { setError("Could not dismiss. Try again."); }
    finally { clearTimeout(timeout); setDismissing(false); }
  }
  const stage = item ? cvActivityStage(item) : -1;
  return <div className="min-w-0 flex-1">
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    {item ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Link prefetch={false} href={`/cv/${item.draftId}`} className="min-w-0 underline" onClick={() => { if (!isCvActive(item)) void dismiss(item.id); }}>
        <strong>{cvActivityLabel(item)}</strong> · {item.company} · {item.jobTitle}
      </Link>
      {item.status === "generating" && (!item.phase || item.phase === "progressing") && <div role="progressbar" aria-label="CV build stage" aria-valuemin={0} aria-valuemax={4} aria-valuenow={stage < 0 ? undefined : stage} aria-valuetext={cvActivityLabel(item)}><ol className="flex gap-1 text-11">
        {CV_ACTIVITY_STAGES.map((label, index) => <li key={label} aria-current={index === stage ? "step" : undefined}
          className={`border-b-2 px-1 ${index <= stage ? "border-brand text-fg" : "border-line-muted text-muted"}`}>{label}</li>)}
      </ol></div>}
      {visible.length > 1 && <Link href="/applications" className="underline">{visible.length} CV updates</Link>}
      {!isCvActive(item) && <button type="button" className="min-h-11 underline" disabled={dismissing} onClick={() => void dismiss(item.id)}>Dismiss</button>}
    </div> : children}
    {error && <span className="text-12 text-muted" role="status">{error}</span>}
  </div>;
}
