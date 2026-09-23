"use client";

import { startTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { acceptFilterSuggestionWithReport, rejectFilterSuggestion } from "@/app/actions/learning";
import { Monogram } from "@/components/brand/Monogram";

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
 * page, which is not in the sidebar; this is the same accept and reject, one line above the table
 * they change, and it says what accepting admitted.
 */
export function SuggestionsStrip({ items }: { items: SuggestionChip[] }) {
  const router = useRouter();
  const [settled, setSettled] = useState<Set<string>>(new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = items.filter(item => !settled.has(item.id));

  function settle(id: string) {
    setSettled(current => new Set([...current, id]));
  }

  function accept(item: SuggestionChip) {
    if (pendingId) return;
    setPendingId(item.id); setError(null); setMessage(null);
    startTransition(async () => {
      try {
        const result = await acceptFilterSuggestionWithReport(item.id);
        if (!result.ok) { setError(result.error); return; }
        settle(item.id);
        setMessage(result.message ?? `Added “${item.term}”.`);
        router.refresh();
      } catch {
        setError("Could not save that. Reload and try again.");
      } finally { setPendingId(null); }
    });
  }

  function dismiss(item: SuggestionChip) {
    if (pendingId) return;
    setPendingId(item.id); setError(null); setMessage(null);
    startTransition(async () => {
      try {
        await rejectFilterSuggestion(item.id);
        settle(item.id);
        setMessage(`Dismissed “${item.term}”.`);
        router.refresh();
      } catch {
        setError("Could not save that. Reload and try again.");
      } finally { setPendingId(null); }
    });
  }

  if (pending.length === 0 && !message && !error) return null;
  const fromScans = pending.length > 0 && pending.every(item => item.fromScans);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-2 border-line-muted px-3 py-2 text-13">
      {pending.length > 0 && <>
        <span className="text-muted">
          {pending.length} {pending.length === 1 ? "suggestion" : "suggestions"} {fromScans ? "from your scans" : "for your filters"}:
        </span>
        {pending.map(item => (
          <span key={item.id} className="flex items-center gap-1.5" title={item.description}>
            <span className="text-fg">{item.term}</span>
            <button type="button" disabled={pendingId !== null} onClick={() => accept(item)} className="text-12 text-muted underline hover:text-fg disabled:opacity-40">Accept</button>
            <button type="button" disabled={pendingId !== null} onClick={() => dismiss(item)} className="text-12 text-muted underline hover:text-fg disabled:opacity-40">Dismiss</button>
          </span>
        ))}
      </>}
      {pendingId !== null && <span className="text-muted"><Monogram size={16} searching title="Saving" /></span>}
      {message && <span role="status" aria-live="polite" className="text-fg">{message}</span>}
      {error && <span role="status" aria-live="polite" className="text-danger">{error}</span>}
      <a href="/learning" className="ml-auto text-12 text-muted underline hover:text-fg">All suggestions</a>
    </div>
  );
}
