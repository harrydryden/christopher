"use client";
import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
export function AutoRefresh({
  cvId,
  initialVersion,
  message = "Waiting for the worker to generate your CV. Status updates automatically.",
}: {
  cvId?: string;
  initialVersion?: string;
  message?: string | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  useEffect(() => {
    let cancelled = false,
      version: string | undefined = initialVersion,
      timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    async function poll() {
      if (cancelled) return;
      if (document.visibilityState === "visible") {
        controller = new AbortController();
        const timeout = setTimeout(() => controller?.abort(), 8000);
        try {
          const response = await fetch(
            `/api/work-status${cvId ? `?cv=${cvId}` : ""}`,
            { cache: "no-store", signal: controller.signal },
          );
          if (!response.ok) throw new Error("Status unavailable");
          const result = (await response.json()) as {
            active: boolean;
            version: string;
          };
          if (cancelled) return;
          if (
            !result.active ||
            (version !== undefined && version !== result.version)
          )
            startTransition(() => router.refresh());
          // Only the rendered page can acknowledge a changed version. A requested
          // refresh may fail; keep retrying while its server-provided version is stale.
          if (version === undefined) version = result.version;
          // Keep retrying until the refreshed page unmounts this component. A failed
          // terminal refresh must not leave a finished build stuck on its progress screen.
        } catch {
          /* Retry transient failures without refreshing an unchanged page. */
        } finally {
          clearTimeout(timeout);
        }
      }
      if (!cancelled) timer = setTimeout(poll, 10000);
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [router, cvId, initialVersion]);
  return message === null ? null : (
    <p role="status" className="text-14">
      {message}
    </p>
  );
}
