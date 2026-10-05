"use client";

import { useState } from "react";
import { acceptFilterSuggestionWithReport, rejectFilterSuggestion } from "@/app/actions/learning";
import { MarkSmall } from "@/components/brand";
import { useActionCall } from "./useActionCall";

/** One pending filter suggestion, reduced to what a single line can carry. */
export interface SuggestionChip {
  id: string;
  /** The term itself — "Lead", "Head of", "partnership*" — not the sentence around it. */
  term: string;
  /** The whole proposal, for the tooltip: "Add “Lead” to seniority labels". */
  description: string;
  /** Mined from a scan (R-5.6) rather than proposed from decisions (R-6.9). */
  fromScans: boolean;
}

/**
 * Filter suggestions where the person already is. Both kinds land in the last card of the Learning
 * page; this is the same accept and reject, in a compact disclosure above the table
 * they change, and it says what accepting admitted.
 */
const SAVE_FAILED = "Could not save. Reload and retry.";

export function SuggestionsStrip({ items }: { items: SuggestionChip[] }) {
  const [settled, setSettled] = useState<Set<string>>(new Set());
  const { pending: pendingId, error, setError, run } = useActionCall<string>();
  const [message, setMessage] = useState<string | null>(null);
  const pending = items.filter(item => !settled.has(item.id));

  function settle(id: string) {
    setSettled(current => new Set([...current, id]));
  }

  function accept(item: SuggestionChip) {
    run(item.id, async () => {
      setMessage(null);
      const result = await acceptFilterSuggestionWithReport(item.id);
      if (!result.ok) { setError(result.error); return; }
      settle(item.id);
      setMessage(result.message ?? `Added “${item.term}”.`);
    }, { failed: SAVE_FAILED });
  }

  function dismiss(item: SuggestionChip) {
    run(item.id, async () => {
      setMessage(null);
      await rejectFilterSuggestion(item.id);
      settle(item.id);
      setMessage(`Dismissed “${item.term}”.`);
    }, { failed: SAVE_FAILED });
  }

  if (pending.length === 0 && !message && !error) return null;
  const fromScans = pending.length > 0 && pending.every(item => item.fromScans);

  return (
    <div className="mb-4 border-2 border-line-muted px-3 text-13">
      {pending.length > 0 && <details>
        <summary className="min-h-11 cursor-pointer py-3 text-muted">
          {pending.length} {pending.length === 1 ? "filter suggestion" : "filter suggestions"}{fromScans ? " from your scans" : " to review"}
        </summary>
        <div className="space-y-2 pb-3">
          {pending.map(item => <div key={item.id} className="flex flex-wrap items-center gap-x-3 border-t border-line-faint" title={item.description}>
            <span className="min-w-0 break-words text-fg">{item.term}</span>
            <button type="button" disabled={pendingId !== null} onClick={() => accept(item)} className="min-h-11 px-1 text-13 text-muted underline hover:text-fg disabled:opacity-40">Accept</button>
            <button type="button" disabled={pendingId !== null} onClick={() => dismiss(item)} className="min-h-11 px-1 text-13 text-muted underline hover:text-fg disabled:opacity-40">Dismiss</button>
          </div>)}
          <a href="/learning" className="inline-flex min-h-11 items-center text-13 text-muted underline hover:text-fg">All suggestions</a>
        </div>
      </details>}
      {pendingId !== null && <span className="text-muted"><MarkSmall size={16} searching title="Saving" /></span>}
      {message && <p role="status" aria-live="polite" className="py-3 text-fg">{message}</p>}
      {error && <p role="alert" className="py-3 text-danger">{error}</p>}
    </div>
  );
}
