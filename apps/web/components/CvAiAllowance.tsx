"use client";

import { useEffect, useState } from "react";

type Window = { limit: number; used: number; reserved: number; resetAt: Date | null };

function ResetTime({ at }: { at: Date | null }) {
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => {
    if (!at) return;
    setLocal(new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(at)));
  }, [at]);
  return <span>{at ? `Resets ${local ?? `${new Date(at).toISOString()} UTC`}` : "Starts with your next AI edit"}</span>;
}

function AllowanceWindow({ label, value }: { label: string; value: Window }) {
  const unavailable = Math.min(value.limit, value.used + value.reserved);
  const remaining = Math.max(0, value.limit - value.used - value.reserved);
  return <div className="min-w-0 flex-1 space-y-1">
    <div className="flex flex-wrap justify-between gap-x-2 text-12"><strong>{label}</strong>
      <span>{remaining} units left{value.reserved > 0 ? ` · ${value.reserved} reserved` : ""}</span></div>
    <meter className="h-2 w-full" aria-label={`${label} AI allowance used or reserved`} min={0} max={value.limit}
      value={unavailable} />
    <p className="text-12 text-muted"><ResetTime at={value.resetAt} /></p>
  </div>;
}

/** Both admission windows stay visible; a reserved edit is not described as spent. */
export function CvAiAllowance({ session, week }: { session: Window; week: Window }) {
  return <section aria-label="AI allowance" className="border border-line-muted p-3">
    <h2 className="mb-2 text-14 font-semibold">AI allowance <a href="/account" className="ml-2 font-normal underline">Plans and credits</a></h2>
    <div className="flex flex-col gap-4 sm:flex-row"><AllowanceWindow label="Five-hour session" value={session} />
      <AllowanceWindow label="Weekly" value={week} /></div>
  </section>;
}
