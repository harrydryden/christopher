"use client";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { EvidenceFacet } from "@col/core/cv-helpers";
import { scoredAsLine } from "@col/core/evidence-rubric";
import type { RowGuidance } from "@/lib/cv-library-evidence";
import { FitBar } from "@/components/table";
import { useAnchoredPanel } from "@/components/useAnchoredPanel";

/**
 * A Library row's score cell: the score as the ten-cell bar, and on a click, what the row is still
 * missing for the types it is tagged with.
 *
 * A click and not a hover, and no `title` anywhere: the guidance is a few lines to act on, which a
 * tooltip neither holds nor lets anyone reach from a keyboard or a touch screen. The panel is a
 * non-modal dialog that stays open while the person reads it and types in the row beside it, and
 * closes on Escape (the caret goes back to the score), on Tab out of it, or on a click or a focus
 * anywhere else.
 *
 * It is laid out against the viewport (`useAnchoredPanel`), like the Type menu, because the rows
 * table is a horizontal scroller that would clip a panel positioned inside it.
 *
 * An untyped row has no score, only the prompt to choose a type; opening it says why. When the
 * full review read the row as something, the panel offers those types as one button: adopting them
 * is the person's choice, made here, and goes through the same path as the Type menu. The review
 * never tags a row itself.
 */
export function RowScoreButton({ index, guidance, onAdopt }: {
  /** The row's number as the # column shows it. */
  index: number;
  guidance: RowGuidance;
  /** Tag the row with the review's reading of it; without it, nothing is offered. */
  onAdopt?: (facets: EvidenceFacet[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const adoptable = guidance.suggested.length > 0 && !!onAdopt;

  useAnchoredPanel({ open, setOpen, root, trigger, panel });

  const name = guidance.score === null
    ? `Select a type for row ${index}`
    : `Score ${guidance.score} of 100 for row ${index}: show what is missing`;

  function onPanelKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    // Tab out of the last thing in the panel goes on to the next control in the row, and the panel
    // goes with it. The one thing that can be focusable inside it is the adopt button, which Tab
    // from the panel itself reaches first.
    if (event.key === "Tab" && !(adoptable && event.target === panel.current && !event.shiftKey)) setOpen(false);
  }

  function adopt() {
    onAdopt?.([...guidance.suggested]);
    setOpen(false);
    trigger.current?.focus();
  }

  function onTriggerKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div ref={root}>
      <button
        ref={trigger}
        type="button"
        aria-label={name}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(current => !current)}
        onKeyDown={onTriggerKey}
        className="min-h-11 cursor-pointer text-left"
      >
        {guidance.score === null
          ? <span className="text-12 text-muted underline">Select type</span>
          : <FitBar score={guidance.score} />}
      </button>
      {open && (
        <div
          ref={panel}
          id={panelId}
          role="dialog"
          aria-label={guidance.heading}
          tabIndex={-1}
          onKeyDown={onPanelKey}
          className="fixed z-20 grid w-80 gap-2 border-2 border-line bg-raised p-3 text-12 shadow-hard-2"
        >
          <p className="font-semibold">{guidance.heading}</p>
          {guidance.missing.map(group => (
            <div key={group.facet} className="grid gap-1">
              <p className="ds-pixel text-9 text-muted">{group.label}</p>
              <ul className="grid list-disc gap-1 pl-4">
                {group.asks.map(ask => <li key={ask}>{ask}</li>)}
              </ul>
            </div>
          ))}
          <p className="text-muted">{guidance.footer}</p>
          {adoptable && (
            <button
              type="button"
              aria-label={`Tag row ${index} as ${scoredAsLine(guidance.suggested)}`}
              onClick={adopt}
              className="justify-self-start text-12 underline"
            >
              Use these types
            </button>
          )}
        </div>
      )}
    </div>
  );
}
