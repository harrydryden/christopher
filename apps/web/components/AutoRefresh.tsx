"use client";
import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { initialWorkPoll, nextPollDelay, stepWorkPoll, type WorkReading } from "@/lib/polling";

/**
 * Refresh the page while work it shows is in flight, and once more when that work finishes.
 *
 * `scope` names which of the account's work the page watches (its companies' or its CVs'), and
 * `initialVersion` is that work's version as the page rendered it; a page that passes both is
 * compared with exactly what it shows. The rules live in lib/polling.ts: one refresh per changed
 * version, a wait that grows from ten seconds to a minute while nothing changes, nothing asked of a
 * hidden tab, and no more asking once the work is finished.
 */
export function AutoRefresh({
  cvId,
  scope,
  initialVersion,
  message = "Waiting for the worker to generate your CV. Status updates automatically.",
}: {
  cvId?: string;
  scope?: "company" | "cv";
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
        if (step.refresh) startTransition(() => router.refresh());
      } catch {
        /* A refused or dropped poll is not news: wait a little longer and ask again. */
        state = { ...state, wait: nextPollDelay(state.wait, false) };
        next = state.wait;
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
