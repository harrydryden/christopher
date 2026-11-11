"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { saveCvAbout, type CvAboutValues } from "@/app/actions/cv-about";

type Snapshot = { version: number; values: CvAboutValues };

export function CvAboutContactForm({ initial }: { initial: Snapshot }) {
  const router = useRouter();
  const [base, setBase] = useState(initial);
  const [values, setValues] = useState(initial.values);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const dirty = JSON.stringify(values) !== JSON.stringify(base.values);
  const newer = initial.version !== base.version;

  useEffect(() => {
    if (!dirty && !inFlight.current && initial.version >= base.version &&
        (initial.version !== base.version || JSON.stringify(initial.values) !== JSON.stringify(base.values))) {
      setBase(initial);
      setValues(initial.values);
    }
  }, [initial, base, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function change(field: keyof CvAboutValues, value: string) {
    setValues(previous => ({ ...previous, [field]: value }));
    setMessage(null);
    setError(null);
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !dirty) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await saveCvAbout(base.version, values);
      if (!result.ok) { setError(result.error); return; }
      setBase({ version: result.version, values });
      setMessage("About you and contact saved.");
      router.refresh();
    } catch {
      setError("We could not confirm the save. Your entries are still here; check saved details before trying again.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  const field = (key: keyof CvAboutValues, label: string, options: { required?: boolean; type?: string; maxLength: number; rows?: number }) =>
    <label key={key} className="flex flex-col gap-1 text-14 font-medium">
      {label}
      {options.rows ? <textarea name={key} value={values[key]} rows={options.rows} maxLength={options.maxLength}
        disabled={pending} onChange={event => change(key, event.target.value)} className="min-h-24 w-full rounded border border-line bg-surface px-3 py-2 font-normal" />
        : <input name={key} value={values[key]} required={options.required} type={options.type ?? "text"}
          maxLength={options.maxLength} disabled={pending} onChange={event => change(key, event.target.value)}
          className="min-h-11 w-full rounded border border-line bg-surface px-3 py-2 font-normal" />}
    </label>;

  return <div className="space-y-4">
    <Link prefetch={false} href="/library" onClick={event => {
      if (dirty && !window.confirm("Leave without saving your contact changes?")) event.preventDefault();
    }} className="inline-flex min-h-11 items-center text-14 underline">Back to Experience</Link>
    <form onSubmit={save} aria-busy={pending} className="grid gap-4 sm:grid-cols-2">
      {field("name", "Name", { required: true, maxLength: 120 })}
      {field("email", "Email", { type: "email", maxLength: 254 })}
      {field("phone", "Phone", { type: "tel", maxLength: 40 })}
      {field("location", "Location", { maxLength: 120 })}
      {field("linkedinUrl", "LinkedIn profile", { type: "url", maxLength: 300 })}
      {field("websiteUrl", "Website", { type: "url", maxLength: 500 })}
      <div className="sm:col-span-2">{field("contact", "Other contact details", { maxLength: 500 })}</div>
      <div className="sm:col-span-2">{field("profile", "About you", { maxLength: 5000, rows: 5 })}</div>
      {newer && dirty && <p role="status" className="text-14 sm:col-span-2">Saved details changed elsewhere. Your entries are still here. Copy anything you need before loading the saved version.</p>}
      {error && <p role="alert" className="text-14 text-danger sm:col-span-2">{error}</p>}
      {message && !dirty && <p role="status" className="text-14 text-success sm:col-span-2">{message}</p>}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button type="submit" disabled={pending || !dirty} className="min-h-11 rounded bg-ink px-4 py-2 text-white disabled:opacity-50">{pending ? "Saving…" : "Save contact details"}</button>
        {newer && dirty && <button type="button" disabled={pending} onClick={() => { setBase(initial); setValues(initial.values); setError(null); setMessage(null); }}
          className="min-h-11 rounded border border-line px-4 py-2 text-14">Load saved version</button>}
      </div>
    </form>
  </div>;
}
