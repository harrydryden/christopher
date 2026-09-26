"use client";
import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { failedWorkPoll, initialWorkPoll, stepWorkPoll, type WorkReading } from "@/lib/polling";

/**
 * Refresh the page while work it shows is in flight, and once more when that work finishes.
 *
 * `scope` names which of the account's work the page watches (its companies', the same work as the
 * Roles page sees it, or its CVs'), and
 * `initialVersion` is that work's version as the page rendered it; a page that passes both is
 * compared with exactly what it shows. The rules live in lib/polling.ts: a refresh per changed
 * version, asked for again a few times while a page that rendered its version has not shown the
 * new one (a landed refresh renders this component with the new `initialVersion`, which starts the
 * poller afresh), a wait that grows from ten seconds to a minute while nothing changes, nothing
 * asked of a hidden tab, and no more asking once the work is finished.
 */
export function AutoRefresh({
  cvId,
  scope,
  initialVersion,
  message = "Waiting for the worker to generate your CV. Status updates automatically.",
}: {
  cvId?: string;
  scope?: "company" | "roles" | "cv";
  initialVersion?: string;
  message?: string | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  useEffect(() => {
    let cancelled = false;
    let state = initialWorkPoll(initialVersion);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let parked = false;
    const url = cvId ? `/api/work-status?cv=${cvId}` : `/api/work-status${scope ? `?scope=${scope}` : ""}`;
    async function poll() {
      timer = undefined;
      if (cancelled) return;
      // A hidden tab asks nothing; the reading it skipped is taken when the tab is next looked at.
      if (document.visibilityState !== "visible") {
        parked = true;
        return;
      }
      let next: number | null;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 8000);
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Status unavailable");
        const reading = (await response.json()) as WorkReading;
        if (cancelled) return;
        const step = stepWorkPoll(state, reading);
        state = step.state;
        next = step.next;
        if (step.reload) {
          // Only an individual CV's build screen has no edits to lose. Other pages can hold
          // unsaved form input, so give them the original final soft-refresh attempt.
          if (cvId) window.location.reload();
          else startTransition(() => router.refresh());
          return;
        }
        if (step.refresh) startTransition(() => router.refresh());
      } catch {
        // A refused or dropped poll is not news: ask again, and back off only when they keep failing.
        const failed = failedWorkPoll(state);
        state = failed.state;
        next = failed.next;
      } finally {
        clearTimeout(timeout);
      }
      if (!cancelled && next !== null) timer = setTimeout(poll, next);
    }
    function onVisibility() {
      if (parked && document.visibilityState === "visible") {
        parked = false;
        void poll();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    // A page that says what it rendered is current now; one that does not is read at once, for the
    // version its later readings are compared with.
    if (initialVersion === undefined) void poll();
    else timer = setTimeout(poll, state.wait);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router, cvId, scope, initialVersion]);
  return message === null ? null : (
    <p role="status" className="text-14">
      {message}
    </p>
  );
}
