"use client";
import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
export function AutoRefresh({ cvId, message = "Waiting for the worker to generate your CV. Status updates automatically." }: { cvId?: string; message?: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  useEffect(() => {
    let cancelled = false, version: string | undefined, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      if (cancelled) return;
      if (document.visibilityState === "visible") {
        try {
          const response = await fetch(`/api/work-status${cvId ? `?cv=${cvId}` : ''}`, { cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error('Status unavailable');
          const result = await response.json() as { active: boolean; version: string };
          if (cancelled) return;
          if (!result.active || version !== undefined && version !== result.version) startTransition(() => router.refresh());
          version = result.version;
          if (!result.active) return;
        } catch { /* A transient status failure must not repeatedly refresh the page. */ }
      }
      if (!cancelled) timer = setTimeout(poll, 10000);
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, [router, cvId]);
  return <p role="status" className="text-sm">{message}</p>;
}
