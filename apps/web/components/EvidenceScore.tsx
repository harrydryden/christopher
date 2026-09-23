"use client";
import { EVIDENCE_RATING_LABELS, type EvidenceEntryView, type EvidencePrompt } from "@/lib/cv-library-evidence";
// Type only: the scorer it belongs to reaches `node:crypto` and never reaches the browser.
import type { EvidenceRating } from "@ava/core/library-review";

/** The three cells the CV evaluation table fills for Evidence and Experience, in the same order. */
const FILLED: Record<EvidenceRating, number> = { none: 0, weak: 1, good: 2, strong: 3 };

/**
 * How much evidence a block carries: the word, the three-cell bar, and the score behind them.
 *
 * The bar is the evaluation table's, deliberately — a reviewer's "Weak" and the Library's "Weak"
 * are the same judgement made at different moments, and they should look the same.
 */
export function EvidenceBar({ rating, score, title }: { rating: EvidenceRating; score: number; title?: string }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-12 font-semibold" title={title}>
      {EVIDENCE_RATING_LABELS[rating]}
      <span aria-hidden="true" className="flex gap-1">
        {[1, 2, 3].map(level => (
          <span key={level} className={`h-1.5 w-4 ${level <= FILLED[rating] ? "bg-accent" : "bg-track"}`} />
        ))}
      </span>
      <span className="font-normal text-muted">{score}/100</span>
    </span>
  );
}

/**
 * One block's evidence, above the rows it is about: the badge, what the pass is doing, what is
 * missing, and the questions that would raise it.
 *
 * The score gates nothing. A block rated None is still evidence if the person says so, and nothing
 * here disables a control or hides a row.
 */
export function EvidenceSummary({
  evidence,
  refusal,
  stale,
  onAddRow,
}: {
  evidence: EvidenceEntryView;
  /** The sentence the worker refused the pass with, when a budget could not admit it. */
  refusal: string | null;
  /** The rows on screen are not the rows this score was computed over. */
  stale: boolean;
  onAddRow?: (prompt: EvidencePrompt) => void;
}) {
  const waiting = evidence.evaluating;
  return (
    <div className="space-y-2 border-2 border-line-muted bg-sunken p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <EvidenceBar rating={evidence.rating} score={evidence.score} />
        <span className="text-12 text-muted">{evidence.missingLine}</span>
        {waiting && <span className="text-12 text-muted" role="status">Evaluating…</span>}
        {!waiting && evidence.source === "rules" && (
          <span className="text-12 text-muted">
            {refusal ? "Scored from your own tags." : "Scored from your own tags, pending a full review."}
          </span>
        )}
      </div>
      {!waiting && refusal && evidence.source === "rules" && (
        <p className="text-12 text-warn">{refusal}</p>
      )}
      {stale && <p className="text-12 text-muted">These rows have changed since they were scored. Save the library to score them again.</p>}
      {evidence.prompts.length > 0 && (
        <ul className="space-y-1">
          {evidence.prompts.map(prompt => (
            <li key={prompt.question} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-12">
              <span>{prompt.question}</span>
              {onAddRow && (
                <button type="button" className="underline" onClick={() => onAddRow(prompt)}>
                  Add a row for this
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
