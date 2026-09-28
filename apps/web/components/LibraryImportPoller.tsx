"use client";
import { useSignatureRefresh } from "./useVisiblePoll";

/**
 * Watch for a document that is still being read, and refresh the page when it lands.
 *
 * Each tick asks `/api/cv/library/imports` how the imports in flight stand (one small aggregate),
 * and the page is refreshed only when that has moved, not on every tick. `signature` is what the
 * page saw when it rendered; `pending` is how many it showed as reading, so an answer reporting
 * fewer means the page is behind even if the fingerprint was read after the import landed.
 *
 * The manners are `useSignatureRefresh`'s: a transition refresh that keeps unsaved text, nothing
 * asked of a hidden tab, a back-off to twenty seconds while nothing changes, and ten minutes of
 * asking, which outlasts the task's four. The page mounts this only while something is being read,
 * so the refresh that lands the proposal also unmounts it.
 */
export function LibraryImportPoller({ pending, signature }: { pending: number; signature: string }) {
  useSignatureRefresh<{ reading: number; signature: string }>(
    { enabled: pending >= 1, url: "/api/cv/library/imports", signature, longestMs: 20000, moved: (result) => result.reading < pending },
    [pending, signature],
  );
  return null;
}
