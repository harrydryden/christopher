"use client";
import { useState } from "react";
export function DiscoverySourceFields() {
  const [kind, setKind] = useState("website");
  const input = "min-h-11 w-full rounded border border-slate-300 bg-transparent p-2 text-sm dark:border-slate-700";
  return <>
    <label className="grid gap-1 text-sm">Source type<select name="kind" value={kind} onChange={e => setKind(e.target.value)} className={input}><option value="website">Website</option><option value="linkedin">LinkedIn post or newsletter</option><option value="email">Email newsletter</option></select></label>
    <label className="grid gap-1 text-sm">Source name<input name="name" required maxLength={200} placeholder="e.g. Scaling Europe Daily" className={input}/></label>
    {kind !== "email" ? <label className="grid gap-1 text-sm">{kind === "linkedin" ? "LinkedIn URL" : "Website URL"}<input name="url" type="url" required maxLength={2048} placeholder="https://…" className={input}/></label>
      : <p className="text-sm text-slate-500">Create the source, then import newsletter text. Creating a source does not subscribe to emails or connect your inbox.</p>}
    {kind === "linkedin" && <p className="text-sm text-slate-500">We read public articles linked from this page. Some editions may require you to import their text; complete newsletter coverage is not guaranteed.</p>}
    <label className="grid gap-1 text-sm">Check every (days)<input name="intervalDays" type="number" min={1} max={90} defaultValue={7} required className={input}/><span className="text-xs text-slate-500">7 days = weekly. The first check is due when you add the source.</span></label>
  </>;
}
