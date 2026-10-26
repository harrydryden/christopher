"use client";

import { useEffect, useState, type FormEvent } from "react";
import { giftAccountCvCredits } from "@/app/actions/account";
import { Button } from "@/components/Button";
import { inputClass } from "@/components/Field";

type Draft = { requestId: string; credits: string; reason: string };

export function GiftCreditsForm({ actorId, userId, email }: { actorId: string; userId: string; email: string }) {
  const key = `admin-credit-gift:${actorId}:${userId}`;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [conflicted, setConflicted] = useState(false);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(key);
      const parsed = saved ? JSON.parse(saved) as Partial<Draft> : null;
      setDraft(parsed && typeof parsed.requestId === "string" && typeof parsed.credits === "string" && typeof parsed.reason === "string"
        ? { requestId: parsed.requestId, credits: parsed.credits, reason: parsed.reason }
        : { requestId: crypto.randomUUID(), credits: "", reason: "" });
    } catch {
      setDraft({ requestId: crypto.randomUUID(), credits: "", reason: "" });
    }
  }, [key]);

  function save(next: Draft) {
    setDraft(next);
    try { sessionStorage.setItem(key, JSON.stringify(next)); } catch { /* The current page still keeps its token. */ }
    setMessage(null);
    setConflicted(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || busy) return;
    setBusy(true);
    setMessage(null);
    // Write before the request so a reload after a lost response retries the same gift.
    try { sessionStorage.setItem(key, JSON.stringify(draft)); } catch { /* In-page retry still works. */ }
    const form = new FormData();
    form.set("userId", userId);
    form.set("requestId", draft.requestId);
    form.set("credits", draft.credits);
    form.set("reason", draft.reason);
    try {
      const result = await giftAccountCvCredits(form);
      if (result.ok) {
        const next = { requestId: crypto.randomUUID(), credits: "", reason: "" };
        setDraft(next);
        try { sessionStorage.setItem(key, JSON.stringify(next)); } catch { /* The form remains usable. */ }
        setMessage({ text: result.alreadyApplied ? "This gift had already been applied. No further credits were added." : `${draft.credits} CV credits gifted to ${email}.`, error: false });
      } else {
        setConflicted(result.code === "conflict");
        setMessage({ text: result.error, error: true });
      }
    } catch {
      setMessage({ text: "The result is unknown. Retry this gift with the same details in this tab; it cannot be added twice.", error: true });
    } finally { setBusy(false); }
  }

  return <form onSubmit={submit} aria-label={`Gift CV credits to ${email}`} className="mt-2 space-y-1.5 border-t border-line-faint pt-2">
    <p className="text-12 font-semibold">Gift CV credits</p>
    <p className="text-12 text-muted">1–100 credits. Gifts do not expire.</p>
    <div className="flex flex-wrap items-end gap-1.5">
      <label className="text-12">Credits
        <input type="number" min="1" max="100" step="1" required disabled={!draft || busy} value={draft?.credits ?? ""}
          onChange={event => draft && save({ ...draft, credits: event.target.value })} className={`${inputClass} mt-1 w-20`} />
      </label>
      <label className="min-w-40 flex-1 text-12">Reason
        <input type="text" minLength={1} maxLength={300} required disabled={!draft || busy} value={draft?.reason ?? ""}
          onChange={event => draft && save({ ...draft, reason: event.target.value })} className={`${inputClass} mt-1`} />
      </label>
      <Button type="submit" size="sm" disabled={!draft || busy}>{busy ? "Gifting…" : "Gift"}</Button>
    </div>
    {message && <p role={message.error ? "alert" : "status"} className={`text-12 ${message.error ? "text-warn" : "text-muted"}`}>{message.text}</p>}
    {conflicted && <Button type="button" variant="secondary" size="sm" onClick={() => {
      const next = { requestId: crypto.randomUUID(), credits: "", reason: "" };
      save(next);
    }}>Start a new gift</Button>}
  </form>;
}
