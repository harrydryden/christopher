"use client";
import { startTransition, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
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
/** One stepped beat for a decided card to leave, plus a frame's grace to start it. */
const LEAVE_MS = 280;
type Direction = "left" | "right";

/**
 * Recommendations one at a time: drag right (or →, or Follow) to follow the company, drag left
 * (or ←, or Dismiss) to dismiss it. The card leaves the moment it is decided and the next one is
 * ready at once; the server actions stay the authority, and a refusal puts the card back on top
 * with the sentence under it. The reason form under the card is the long way round, for a
 * dismissal that should teach the next recommendations something.
 *
 * `cards` is the first few pending suggestions, not all of them; `total` is how many are pending,
 * for the count. Each decision's own response re-renders the page, which refills the deck.
 */
export function SuggestionDeck({ cards, total = cards.length, empty, disabledReason }: {
  cards: DeckCard[]; total?: number; empty: ReactNode; disabledReason?: string;
}) {
  const root = useRef<HTMLElement>(null);
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  // Cards whose decision the server has not answered yet, one entry each: deciding the next card
  // never waits for the last one.
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(() => new Set());
  const inFlightRef = useRef(new Set<string>());
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [entered, setEntered] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const start = useRef<{ x: number; pointerId: number } | null>(null);
  // The decided card's picture flying off the edge, drawn over the deck for one stepped beat while
  // the next card is already live underneath. It is only a picture: it takes no pointer or focus.
  const [leaving, setLeaving] = useState<{ card: DeckCard; from: number; to: number; flying: boolean } | null>(null);
  const dxRef = useRef(dx);
  dxRef.current = dx;
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  const visible = cards.filter((card) => !gone.has(card.id));
  const current = visible[0];
  const next = visible[1];
  const disabled = !!disabledReason;
  // Cards decided here but still in the list the page last rendered are not "to review" any more.
  const remaining = Math.max(visible.length, total - cards.filter((card) => gone.has(card.id)).length);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // The card underneath slides up into place when it becomes the top one.
  const currentId = current?.id;
  const leavingId = leaving?.card.id;
  useEffect(() => {
    if (!leavingId) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setLeaving((now) => (now?.card.id === leavingId ? { ...now, flying: true } : now)));
    });
    const done = setTimeout(() => setLeaving((now) => (now?.card.id === leavingId ? null : now)), LEAVE_MS);
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); clearTimeout(done); };
  }, [leavingId]);
  useEffect(() => {
    // A drag belongs to the card it started on. When another card takes the top while the pointer
    // is down (a refused decision coming back on top), letting go must not decide that card.
    start.current = null;
    setDragging(false);
    setDx(0);
    if (!currentId) return;
    setEntered(false);
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
    return () => cancelAnimationFrame(frame);
  }, [currentId]);

  const decide = useCallback((direction: Direction) => {
    const card = visible[0];
    if (!card || disabled || inFlightRef.current.has(card.id)) return;
    inFlightRef.current.add(card.id);
    setInFlight((previous) => new Set(previous).add(card.id));
    setError(null);
    setNotice(null);
    // Gone now: the next card is on top and can be decided while this one is saved.
    setGone((previous) => new Set(previous).add(card.id));
    if (!reducedMotionRef.current) {
      setLeaving({ card, from: dxRef.current, to: direction === "right" ? window.innerWidth : -window.innerWidth, flying: false });
    }
    setDx(0);
    const typed = reason.trim();
    setReason("");
    const refused = (sentence: string) => {
      setGone((previous) => { const kept = new Set(previous); kept.delete(card.id); return kept; });
      setLeaving((now) => (now?.card.id === card.id ? null : now));
      setError(sentence);
      if (typed) setReason((now) => now || typed);
    };
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
        if (!result.ok) { refused(result.error); return; }
        setNotice(result.message ?? (direction === "right" ? `${card.name} followed.` : `${card.name} dismissed.`));
      } catch {
        refused("Could not save. Try again.");
      } finally {
        inFlightRef.current.delete(card.id);
        setInFlight((previous) => { const left = new Set(previous); left.delete(card.id); return left; });
      }
    });
  }, [visible, disabled, reason]);

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
      if (!canDecide.current) return;
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
    if (disabled || event.button !== 0) return;
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

  const saving = inFlight.size > 0;
  const busyHere = inFlight.has(current?.id ?? "");

  if (!current) {
    return (
      <div className="space-y-3">
        {error && <p role="alert" className="text-14 text-danger">{error}</p>}
        {notice && <p role="status" className="border-2 border-ok px-3 py-2 text-14 text-ok">{notice}</p>}
        {/* Every card on hand was decided faster than the answers came back: the next ones
            arrive with them, so this is a wait, not an empty deck. */}
        {saving && remaining > 0
          ? <p role="status" className="flex items-center gap-2 text-14 text-muted"><Monogram size={16} searching title="Saving" /> Loading the next companies…</p>
          : empty}
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
        {remaining} to review · drag or press <kbd>→</kbd> follow, <kbd>←</kbd> dismiss
      </p>
      <div className="overflow-x-clip p-3">
        <div className="relative">
          {next && <div aria-hidden="true" className="pointer-events-none absolute inset-0 translate-x-2 translate-y-2 border-2 border-line-muted bg-sunken" />}
          <article
            key={current.id}
            aria-label={current.name}
            aria-busy={busyHere || undefined}
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
          {leaving && (
            <div
              aria-hidden="true"
              inert
              data-leaving={leaving.card.id}
              style={{
                transform: `translateX(${leaving.flying ? leaving.to : leaving.from}px) rotate(${Math.max(-6, Math.min(6, (leaving.flying ? leaving.to : leaving.from) / 40))}deg)`,
                transition: leaving.flying ? "transform 240ms var(--ease-step-4)" : "none",
              }}
              className="pointer-events-none absolute inset-0 overflow-hidden border-2 border-line bg-raised p-4 shadow-hard-2"
            >
              {leaving.card.body}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button className="min-h-11" onClick={() => decide("left")} disabled={disabled || busyHere}>⟵ Dismiss</Button>
        <Button className="min-h-11" variant="primary" onClick={() => decide("right")} disabled={disabled || busyHere}>Follow ⟶</Button>
        {saving && <Monogram size={16} searching title="Saving" />}
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
          <div><Button className="min-h-11" type="submit" size="sm" disabled={disabled || busyHere}>Dismiss</Button></div>
        </form>
      </details>
    </section>
  );
}
