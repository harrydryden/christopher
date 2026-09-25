"use client";
import { useCallback, useEffect, useRef, useState, useTransition, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { acceptSuggestion, rejectSuggestion } from "@/app/actions/suggestions";
import { Button } from "@/components/Button";
import { labelClass } from "@/components/Field";
import { Monogram } from "@/components/brand";

export interface DeckCard {
  id: string;
  name: string;
  /** The card's face, rendered on the server: name, one-liner, badges, evidence, careers link. */
  body: ReactNode;
}

/** How far a card has to travel before letting go decides it. */
const THRESHOLD = 120;
type Direction = "left" | "right";

/**
 * Recommendations one at a time: drag right (or →, or Follow) to follow the company, drag left
 * (or ←, or Dismiss) to dismiss it. The server actions stay the authority — a refusal snaps the
 * card back with the sentence under it — and the reason form under the card is the long way round,
 * for a dismissal that should teach the next recommendations something.
 */
export function SuggestionDeck({ cards, empty, disabledReason }: { cards: DeckCard[]; empty: ReactNode; disabledReason?: string }) {
  const root = useRef<HTMLElement>(null);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [entered, setEntered] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const start = useRef<{ x: number; pointerId: number } | null>(null);
  const busy = useRef(false);

  const visible = cards.filter((card) => !gone.has(card.id));
  const current = visible[0];
  const next = visible[1];
  const disabled = !!disabledReason;

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // The card underneath slides up into place when it becomes the top one.
  const currentId = current?.id;
  useEffect(() => {
    if (!currentId) return;
    setEntered(false);
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
    return () => cancelAnimationFrame(frame);
  }, [currentId]);

  const decide = useCallback((direction: Direction) => {
    const card = visible[0];
    if (!card || busy.current || disabled) return;
    busy.current = true;
    setError(null);
    setNotice(null);
    // Off the edge while the server answers; back to the middle if it refuses.
    setDx(direction === "right" ? window.innerWidth : -window.innerWidth);
    const typed = reason.trim();
    startTransition(async () => {
      try {
        let result;
        if (direction === "right") {
          result = await acceptSuggestion(card.id);
        } else {
          // A swipe with nothing typed files no reason: a placeholder would be read by the
          // preference profile as if the person had written it. The company stays excluded.
          const form = new FormData();
          form.set("reason", typed);
          if (!typed) form.set("quick", "1");
          result = await rejectSuggestion(card.id, form);
        }
        if (!result.ok) {
          setError(result.error);
          setDx(0);
          return;
        }
        setNotice(result.message ?? (direction === "right" ? `${card.name} followed.` : `${card.name} dismissed.`));
        setGone((previous) => new Set(previous).add(card.id));
        setReason("");
        setDx(0);
        router.refresh();
      } catch {
        setError("Could not save. Try again.");
        setDx(0);
      } finally {
        busy.current = false;
      }
    });
  }, [visible, disabled, reason, router]);

  const decideRef = useRef(decide);
  decideRef.current = decide;
  // Arrow keys act only while a card can be decided, and only when focus is on the page itself or
  // inside the deck: a key pressed on a nav link or a catalogue Follow button must not follow or
  // dismiss a company, and arrow-key scrolling stays intact when nothing is here to decide.
  const canDecide = useRef(false);
  canDecide.current = !!current && !disabled;
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!canDecide.current || busy.current) return;
      const target = event.target as HTMLElement | null;
      if (target && target !== document.body && !root.current?.contains(target)) return;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      decideRef.current(event.key === "ArrowRight" ? "right" : "left");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (disabled || busy.current || event.button !== 0) return;
    // Links and controls on the card keep their own clicks.
    if ((event.target as HTMLElement).closest("a, button, input, textarea, select, label, summary")) return;
    start.current = { x: event.clientX, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }
  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    if (!start.current || start.current.pointerId !== event.pointerId) return;
    setDx(event.clientX - start.current.x);
  }
  function onPointerUp(event: ReactPointerEvent<HTMLElement>) {
    if (!start.current || start.current.pointerId !== event.pointerId) return;
    const travelled = event.clientX - start.current.x;
    start.current = null;
    setDragging(false);
    if (travelled >= THRESHOLD) decide("right");
    else if (travelled <= -THRESHOLD) decide("left");
    else setDx(0);
  }
  function onPointerCancel() {
    start.current = null;
    setDragging(false);
    setDx(0);
  }

  if (!current) {
    return (
      <div className="space-y-3">
        {notice && <p role="status" className="border-2 border-ok px-3 py-2 text-14 text-ok">{notice}</p>}
        {empty}
      </div>
    );
  }

  // The card is wide, so a little rotation reads as a lot.
  const rotate = Math.max(-6, Math.min(6, dx / 40));
  const follow = Math.max(0, Math.min(1, dx / THRESHOLD));
  const dismiss = Math.max(0, Math.min(1, -dx / THRESHOLD));
  const transform = entered ? `translateX(${dx}px) rotate(${rotate}deg)` : "translate(8px, 8px)";
  // Stepped like every other motion in the system; none at all when motion is reduced or the
  // card is under the pointer.
  const transition = dragging || reducedMotion ? "none" : "transform 240ms steps(4, end)";

  return (
    <section ref={root} aria-label="Suggestions to review" className="space-y-3">
      <p className="text-12 text-muted">
        {visible.length} to review · drag or press <kbd>→</kbd> follow, <kbd>←</kbd> dismiss
      </p>
      <div className="overflow-x-clip p-3">
        <div className="relative">
          {next && <div aria-hidden="true" className="pointer-events-none absolute inset-0 translate-x-2 translate-y-2 border-2 border-line-muted bg-sunken" />}
          <article
            key={current.id}
            aria-label={current.name}
            aria-busy={pending || undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            style={{ transform, transition }}
            className={`relative touch-pan-y border-2 border-line bg-raised p-4 shadow-hard-2 ${disabled ? "" : "cursor-grab"} ${dragging ? "cursor-grabbing select-none" : ""}`}
          >
            <span aria-hidden="true" style={{ opacity: follow }} className="ds-pixel pointer-events-none absolute top-3 left-3 border-2 border-ok bg-raised px-2 py-1 text-12 text-ok">
              Follow ⟶
            </span>
            <span aria-hidden="true" style={{ opacity: dismiss }} className="ds-pixel pointer-events-none absolute top-3 right-3 border-2 border-danger bg-raised px-2 py-1 text-12 text-danger">
              ⟵ Dismiss
            </span>
            {current.body}
          </article>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button className="min-h-11" onClick={() => decide("left")} disabled={disabled || pending}>⟵ Dismiss</Button>
        <Button className="min-h-11" variant="primary" onClick={() => decide("right")} disabled={disabled || pending}>Follow ⟶</Button>
        {pending && <Monogram size={16} searching title="Saving" />}
      </div>
      {disabledReason && <p role="status" className="text-12 text-warn">{disabledReason}</p>}
      {error && <p role="alert" className="text-14 text-danger">{error}</p>}
      {notice && <p role="status" className="text-14 text-ok">{notice}</p>}

      <details className="border-t border-line-muted pt-3">
        <summary className="cursor-pointer py-1 text-12 text-muted underline">Dismiss with a reason…</summary>
        <form
          className="mt-2 grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!reason.trim()) { setError("Give a brief reason, or swipe left to dismiss without one."); return; }
            decide("left");
          }}
        >
          <label className="grid gap-1.5">
            <span className={labelClass}>Why not {current.name}?</span>
            <textarea
              name="reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={1000}
              rows={2}
              placeholder="e.g. recruitment agency; I prefer product companies"
              className="w-full border border-line-muted bg-transparent p-2"
            />
          </label>
          <div><Button className="min-h-11" type="submit" size="sm" disabled={disabled || pending}>Dismiss</Button></div>
        </form>
      </details>
    </section>
  );
}
