"use client";
import { useState } from "react";
import { inputClass, labelClass, selectClass } from "@/components/Field";
export function DiscoverySourceFields() {
  const [kind, setKind] = useState("website");
  const input = `min-h-11 ${inputClass}`;
  return <>
    <label className="grid gap-1.5"><span className={labelClass}>Type</span><select name="kind" value={kind} onChange={e => setKind(e.target.value)} className={`min-h-11 ${selectClass}`}><option value="website">Website</option><option value="linkedin">LinkedIn post or newsletter</option><option value="email">Email newsletter</option></select></label>
    <label className="grid gap-1.5"><span className={labelClass}>Name</span><input name="name" required maxLength={200} placeholder="e.g. Scaling Europe Daily" className={input}/></label>
    {kind !== "email" ? <label className="grid gap-1 text-14">{kind === "linkedin" ? "LinkedIn URL" : "Website URL"}<input name="url" type="url" required maxLength={2048} placeholder="https://…" className={input}/></label>
      : <p className="text-12 text-muted">Creating it does not subscribe you; import each edition afterwards.</p>}
    {kind === "linkedin" && <p className="text-12 text-muted">LinkedIn cannot be read automatically; import each edition afterwards.</p>}
    <label className="grid gap-1.5"><span className={labelClass}>Check every (days)</span><input name="intervalDays" type="number" min={1} max={90} defaultValue={7} required className={input}/></label>
  </>;
}
