"use client";
import { useState } from "react";
import { inputClass } from "@/components/Field";
export function DiscoverySourceFields() {
  const [kind, setKind] = useState("website");
  const input = `min-h-11 ${inputClass}`;
  return <>
    <label className="grid gap-1 text-14">Source type<select name="kind" value={kind} onChange={e => setKind(e.target.value)} className={input}><option value="website">Website</option><option value="linkedin">LinkedIn post or newsletter</option><option value="email">Email newsletter</option></select></label>
    <label className="grid gap-1 text-14">Source name<input name="name" required maxLength={200} placeholder="e.g. Scaling Europe Daily" className={input}/></label>
    {kind !== "email" ? <label className="grid gap-1 text-14">{kind === "linkedin" ? "LinkedIn URL" : "Website URL"}<input name="url" type="url" required maxLength={2048} placeholder="https://…" className={input}/></label>
      : <p className="text-14 text-muted">Create the source, then import newsletter text. Creating a source does not subscribe to emails or connect your inbox.</p>}
    {kind === "linkedin" && <p className="text-14 text-muted">We read public articles linked from this page. Some editions may require you to import their text; complete newsletter coverage is not guaranteed.</p>}
    <label className="grid gap-1 text-14">Check every (days)<input name="intervalDays" type="number" min={1} max={90} defaultValue={7} required className={input}/><span className="text-12 text-muted">7 days = weekly. The first check is due when you add the source.</span></label>
  </>;
}
