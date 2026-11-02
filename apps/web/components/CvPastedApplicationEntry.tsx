"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createCvApplicationContext } from "@/app/actions/cv-editing";

/** A role outside Find roles can start Manual without an Auto build or an invented advert. */
export function CvPastedApplicationEntry() {
  const router = useRouter();
  const requestKey = useRef(`paste:${crypto.randomUUID()}`);
  const [companyName, setCompanyName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function open() {
    if (pending || !companyName.trim() || !jobTitle.trim()) return;
    setPending(true); setError(null);
    try {
      const result = await createCvApplicationContext({ requestKey: requestKey.current,
        companyName: companyName.trim(), jobTitle: jobTitle.trim(), description: description.trim() });
      if (!result.ok) setError(result.error);
      else router.push(`/cv/context/${result.contextId}`);
    } catch { setError("Could not open this application. Your role details remain here."); }
    finally { setPending(false); }
  }
  return <details className="border border-line-muted p-3 text-14">
    <summary className="min-h-11 cursor-pointer font-medium">Start an application from a role you found yourself</summary>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="space-y-1"><span className="block">Company</span><input className="min-h-11 w-full border border-line-muted bg-raised px-3"
        maxLength={160} value={companyName} onChange={event => setCompanyName(event.target.value)} /></label>
      <label className="space-y-1"><span className="block">Role</span><input className="min-h-11 w-full border border-line-muted bg-raised px-3"
        maxLength={160} value={jobTitle} onChange={event => setJobTitle(event.target.value)} /></label>
      <label className="space-y-1 sm:col-span-2"><span className="block">Role description, if you have it</span>
        <textarea className="min-h-24 w-full border border-line-muted bg-raised p-3" maxLength={60000}
          value={description} onChange={event => setDescription(event.target.value)} /></label>
    </div>
    <button type="button" className="mt-3 min-h-11 border border-line-muted px-4" disabled={pending || !companyName.trim() || !jobTitle.trim()}
      onClick={open}>{pending ? "Opening…" : "Open application workspace · free"}</button>
    <p className="mt-2 text-12 text-muted">Choose Auto, Refine or Manual there. You can start Manual without generating a CV.</p>
    {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
  </details>;
}
