"use client";
import { useSignatureRefresh } from "./useVisiblePoll";

/**
 * Watch one saved Library version's evidence reviews and refresh the page when they move.
 *
 * It asks nothing of a hidden tab (and gives the time away back to its ten minutes), aborts a
 * request that outlives its usefulness, and refreshes through a transition so the editor above it
 * is re-rendered rather than remounted — which is what keeps unsaved text on the screen while a
 * score arrives underneath it (`useSignatureRefresh`).
 *
 * It backs off to thirty seconds while nothing changes, because the baseline lands in seconds and
 * the model's review in minutes; a pass has four minutes, and the ten this watches for outlast it.
 * The page mounts it only while something is still being evaluated, so the refresh that lands the
 * last review also unmounts the poller.
 */
export function LibraryEvidencePoller({ version, signature }: { version: number; signature: string }) {
  useSignatureRefresh(
    { enabled: Number.isInteger(version) && version >= 1, url: `/api/cv/library/reviews?version=${version}`, signature, longestMs: 30000 },
    [version, signature],
  );
  return null;
}
