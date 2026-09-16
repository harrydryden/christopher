"use client";
import { useState } from "react";
import { inputClass, labelClass, selectClass } from "@/components/Field";
export function DiscoverySourceFields() {
  const [kind, setKind] = useState("website");
  const input = `min-h-11 ${inputClass}`;
  return <>
    <label className="grid gap-1.5"><span className={labelClass}>Source type</span><select name="kind" value={kind} onChange={e => setKind(e.target.value)} className={`min-h-11 ${selectClass}`}><option value="website">Website</option><option value="linkedin">LinkedIn post or newsletter</option><option value="email">Email newsletter</option></select></label>
    <label className="grid gap-1.5"><span className={labelClass}>Source name</span><input name="name" required maxLength={200} placeholder="e.g. Scaling Europe Daily" className={input}/></label>
    {kind !== "email" ? <label className="grid gap-1 text-14">{kind === "linkedin" ? "LinkedIn URL" : "Website URL"}<input name="url" type="url" required maxLength={2048} placeholder="https://…" className={input}/></label>
      : <p className="text-14 text-muted">Create the source, then import newsletter text. Creating a source does not subscribe to emails or connect your inbox.</p>}
    {kind === "linkedin" && <p className="text-14 text-muted">LinkedIn does not allow automated reading. Create the source, then either subscribe with the delivery address it shows, or paste each edition&rsquo;s text.</p>}
    <label className="grid gap-1.5"><span className={labelClass}>Check every (days)</span><input name="intervalDays" type="number" min={1} max={90} defaultValue={7} required className={input}/><span className="text-12 text-muted">7 days = weekly. The first check is due when you add the source.</span></label>
  </>;
}
