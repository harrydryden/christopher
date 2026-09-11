"use client";
import { useRef, useState, type ReactNode } from "react";
import type { DiscoveryActionResult } from "@/lib/discovery-ux";

export function DiscoverySourceForm({ action, children, className, returnTo = "/suggestions?view=sources", pendingLabel = "Saving…" }: {
  action: (data: FormData) => Promise<DiscoveryActionResult>; children: ReactNode; className?: string;
  returnTo?: string; pendingLabel?: string;
}) {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <form className={className} onSubmit={async event => {
    event.preventDefault();
    if (busy.current) return;
    const data = new FormData(event.currentTarget);
    busy.current = true; setPending(true); setError(null);
    try {
      const result = await action(data);
      if (!result.ok) { setError(result.error); busy.current = false; setPending(false); return; }
      const url = new URL(returnTo, window.location.origin);
      url.searchParams.set("notice", result.message);
      window.location.assign(url.pathname + url.search);
    } catch {
      setError("This change could not be completed. Your entries are still here; please try again.");
      busy.current = false; setPending(false);
    }
  }}>
    <fieldset disabled={pending} className="contents">{children}</fieldset>
    {pending && <p role="status" className="text-sm text-slate-500">{pendingLabel}</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </form>;
}
