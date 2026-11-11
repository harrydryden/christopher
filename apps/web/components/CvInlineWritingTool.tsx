"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CvInlineAction, CvInlineRunView, CvInlineSource, CvInlineTarget } from "@col/core/cv-inline-ai";
import { dismissCvInlineEdit, latestCvInlineEdit, readCvInlineEdit, requestCvInlineEdit } from "@/app/actions/cv-inline-ai";

export type CvInlineQuote = { charge: "role_credit" | "allowance"; units: number; priceVersion: number };
export type CvInlineQuotes = Record<CvInlineAction, CvInlineQuote>;

const actions: Array<{ id: CvInlineAction; label: string }> = [
  { id: "inline_correction", label: "Fix spelling & grammar" },
  { id: "inline_refine", label: "Refine wording" },
  { id: "inline_tailor", label: "Tailor to this role" },
];

function sameSource(a: CvInlineSource, b: CvInlineSource) {
  return a.kind === b.kind && a.id === b.id && a.revision === b.revision;
}

function quotedCost(quote: CvInlineQuote) {
  return quote.charge === "role_credit" ? "1 role credit for the first successful AI result"
    : `${quote.units} AI ${quote.units === 1 ? "unit" : "units"}`;
}

/** A saved proposal changes no document text until the person chooses Use change. */
export function CvInlineWritingTool({ contextId, source, target, label, text, quotes, disabled = false,
  onUseChange, useLabel = "Use change", getSelection }: {
  contextId: string; source: CvInlineSource | null; target: CvInlineTarget | null;
  label: string; text: string; quotes: CvInlineQuotes; disabled?: boolean;
  onUseChange: (wholeField: string) => Promise<boolean>; useLabel?: string;
  getSelection?: () => { start: number; end: number } | null;
}) {
  const router = useRouter();
  const costId = useId();
  const [open, setOpen] = useState(false);
  const [run, setRun] = useState<CvInlineRunView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{ href?: string; label?: string; resetAt?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const intent = useRef<{ signature: string; key: string } | null>(null);
  const selection = useRef<{ start: number; end: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const refreshed = useRef<string | null>(null);
  const activeRun = run && source && target && sameSource(run.source, source) &&
    run.target.type === target.type && run.target.id === target.id && run.target.field === target.field ? run : null;
  const stale = !!activeRun && text !== activeRun.text;
  useEffect(() => {
    if (!open) return;
    const place = () => {
      if (!menu.current || !button.current) return;
      const anchor = button.current.getBoundingClientRect();
      const width = menu.current.getBoundingClientRect().width;
      menu.current.style.right = "auto";
      menu.current.style.left = `${Math.max(16, Math.min(anchor.left, window.innerWidth - width - 16)) - anchor.left}px`;
    };
    const frame = requestAnimationFrame(() => { place(); menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(); });
    window.addEventListener("resize", place);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", place); };
  }, [open]);
  useEffect(() => { selection.current = null; }, [text, target?.id, target?.field]);
  useEffect(() => {
    if (!activeRun || !["ready", "failed", "dismissed"].includes(activeRun.status)) return;
    const key = `${activeRun.id}:${activeRun.status}`;
    if (refreshed.current === key) return;
    refreshed.current = key;
    if (activeRun.status !== "ready") intent.current = null;
    router.refresh();
  }, [activeRun?.id, activeRun?.status, router]);
  useEffect(() => {
    if (!open || !source || !target || activeRun) return;
    let live = true;
    void latestCvInlineEdit(contextId, target.id, target.field).then(result => {
      if (live && result.ok && sameSource(result.run.source, source) &&
        result.run.target.type === target.type && result.run.target.field === target.field) setRun(result.run);
    }).catch(() => {});
    return () => { live = false; };
  }, [open, contextId, source?.kind, source?.id, source?.revision, target?.id, target?.type, target?.field, activeRun]);
  useEffect(() => {
    if (activeRun?.status !== "queued") return;
    let live = true;
    const timer = window.setInterval(() => {
      void readCvInlineEdit(activeRun.id).then(result => {
        if (live && result.ok) setRun(result.run);
      }).catch(() => {});
    }, 2_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [activeRun?.id, activeRun?.status]);
  async function request(action: CvInlineAction) {
    if (!source || !target || !text.trim() || disabled || pending) return;
    const quote = quotes[action];
    const selected = selection.current ?? getSelection?.() ?? null;
    const signature = JSON.stringify({ contextId, source, target, text, action, quote, selected });
    if (intent.current?.signature !== signature) intent.current = { signature, key: crypto.randomUUID() };
    setPending(true); setError(null); setRecovery(null); setNotice(null); setOpen(false);
    try {
      const result = await requestCvInlineEdit({ contextId, source, target, text, action,
        requestKey: intent.current.key, acceptRoleCredit: quote.charge === "role_credit",
        priceVersion: quote.priceVersion,
        ...(selected && selected.end > selected.start ? { selectionStart: selected.start, selectionEnd: selected.end } : {}) });
      if (!result.ok) { setError(result.error); setRecovery(result.recovery ?? null); router.refresh(); }
      else { setRun(result.run); setNotice(result.run.status === "ready" ? "Writing suggestion ready." : "Writing help is in progress.");
        router.refresh(); }
    } catch { setError("Could not request writing help. Your wording is unchanged."); }
    finally { setPending(false); }
  }
  async function dismiss() {
    if (!activeRun || pending) return;
    setPending(true); setError(null);
    try {
      const result = await dismissCvInlineEdit(activeRun.id);
      if (!result.ok) setError(result.error);
      else { intent.current = null; setRun(null); setNotice("Suggestion dismissed. Your wording is unchanged."); router.refresh(); }
    } catch { setError("Could not dismiss this suggestion. Try again."); }
    finally { setPending(false); }
  }
  async function useChange() {
    if (!activeRun?.proposedText || stale || pending) return;
    const next = activeRun.text.slice(0, activeRun.selectionStart) + activeRun.proposedText +
      activeRun.text.slice(activeRun.selectionEnd);
    setPending(true); setError(null);
    try {
      if (await onUseChange(next)) { intent.current = null; setRun(null); setNotice("Change saved to the current CV."); }
      else setError("Could not save this change. Your wording and suggestion remain here.");
    } catch { setError("Could not save this change. Your wording and suggestion remain here."); }
    finally { setPending(false); }
  }
  return <div className="relative inline-flex flex-wrap items-center gap-2">
    <button ref={button} type="button" aria-label={`Help me write: ${label}`} aria-expanded={open}
      aria-haspopup="menu" disabled={disabled || pending || !source || !target || !text.trim()}
      className="group relative inline-flex min-h-11 min-w-11 items-center justify-center border border-line-muted bg-raised text-accent"
      onPointerDown={() => { selection.current = getSelection?.() ?? null; }}
      onClick={() => { if (!open && !selection.current) selection.current = getSelection?.() ?? null; setOpen(value => !value); }}
      onKeyDown={event => { if (event.key === "Escape") setOpen(false); }}>
      <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18" shapeRendering="crispEdges" fill="currentColor">
        <path d="M7 2h2v4h2v2h4v2h-4v2H9v4H7v-4H5v-2H1V8h4V6h2z M16 0h2v2h2v2h-2v2h-2V4h-2V2h2z M16 14h2v2h2v2h-2v2h-2v-2h-2v-2h2z" />
      </svg>
      <span role="tooltip" className="pointer-events-none absolute bottom-full right-0 z-20 mb-2 hidden whitespace-nowrap bg-fg px-2 py-1 text-12 text-bg group-hover:block group-focus-visible:block">Help me write</span>
    </button>
    {open && <div ref={menu} role="menu" aria-label={`Writing help for ${label}`} className="absolute right-0 top-full z-30 mt-1 w-64 max-w-[calc(100vw-2rem)] border border-line-muted bg-raised p-1 shadow-lg"
      onKeyDown={event => {
        if (event.key === "Escape") { setOpen(false); button.current?.focus(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : event.key === "ArrowDown" ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
        items[next]?.focus(); event.preventDefault();
      }}>
      {actions.map(action => <button key={action.id} type="button" role="menuitem" className="flex min-h-11 w-full flex-col items-start px-3 py-2 text-left hover:bg-sunken"
        aria-label={action.label} aria-describedby={`${costId}-${action.id}`}
        onClick={() => void request(action.id)}><span>{action.label}</span><small id={`${costId}-${action.id}`} className="text-muted">{quotedCost(quotes[action.id])}</small></button>)}
    </div>}
    {activeRun && <section aria-label={`Writing suggestion for ${label}`} className="w-full border border-line-muted bg-raised p-3 text-14">
      {activeRun.status === "queued" ? <p role="status">Writing suggestion in progress…</p>
        : activeRun.status === "failed" ? <p role="alert">{activeRun.error || "Writing help failed. Your wording is unchanged."}</p>
          : activeRun.status === "ready" && activeRun.proposedText ? <>
            <div className="grid gap-2 sm:grid-cols-2"><div><h3 className="font-medium">Current wording</h3>
              <p className="whitespace-pre-wrap">{activeRun.beforeText}</p></div><div><h3 className="font-medium">Suggested wording</h3>
              <p className="whitespace-pre-wrap">{activeRun.proposedText}</p></div></div>
            {stale && <p role="alert" className="text-warn">This text changed while the suggestion was open. Keep your edits or ask for a new suggestion.</p>}
            <div className="mt-2 flex flex-wrap gap-2"><button type="button" className="min-h-11 border border-line-muted px-3"
              disabled={pending || stale} onClick={() => void useChange()}>{useLabel}</button>
              <button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending}
                onClick={() => void dismiss()}>Dismiss</button></div>
          </> : null}
      {activeRun.status !== "ready" && <button type="button" className="min-h-11 underline" disabled={pending}
        onClick={() => void dismiss()}>Dismiss</button>}
    </section>}
    {notice && <span role="status" className="text-12">{notice}</span>}
    {error && <div role="alert" className="text-12 text-danger"><p>{error} You can still edit and save your CV.</p>
      {recovery?.href && recovery.label && <a href={recovery.href} className="inline-flex min-h-11 items-center underline">{recovery.label}</a>}
      {recovery?.resetAt && <p>Resets {new Date(recovery.resetAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}.</p>}
    </div>}
  </div>;
}
