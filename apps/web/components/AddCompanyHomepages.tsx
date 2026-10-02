"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { addCompaniesInline } from "@/app/actions/companies";
import { Button } from "@/components/Button";
import { inputClass, labelClass } from "@/components/Field";
import { useActionCall } from "@/components/useActionCall";

/** Keep the whole batch when capacity is refused, including a visit to Account and back. */
export function AddCompanyHomepages({ userId, homepage, domain, blockedReason }: {
  userId: string; homepage?: string; domain?: string; blockedReason?: string | null;
}) {
  const router = useRouter();
  const bulk = homepage === undefined;
  const storageKey = `company-homepages:v1:${userId}`;
  const [urls, setUrls] = useState(homepage ?? "");
  const [recovery, setRecovery] = useState<{ href: string; label: string } | null>(null);
  const call = useActionCall();
  useEffect(() => {
    if (!bulk) return;
    try { setUrls(sessionStorage.getItem(storageKey)?.slice(0, 6000) ?? ""); } catch { /* Storage is optional. */ }
  }, [bulk, storageKey]);

  function remember(value: string) {
    setUrls(value);
    if (bulk) try { sessionStorage.setItem(storageKey, value); } catch { /* The live form still keeps it. */ }
  }

  return <form className={bulk ? "mt-3 grid gap-3" : "flex flex-wrap items-center justify-between gap-3 border-t border-line-faint py-2"}
    onSubmit={event => {
      event.preventDefault();
      if (blockedReason) return;
      const form = new FormData();
      form.set("urls", bulk ? urls : homepage ?? "");
      form.set("returnTo", "/suggestions");
      if (bulk) form.set("bulk", "1");
      call.run(true, async () => {
        setRecovery(null);
        const result = await addCompaniesInline(form);
        if (!result.ok) { call.setError(result.error); setRecovery(result.recovery ?? null); return; }
        if (bulk) { setUrls(""); try { sessionStorage.removeItem(storageKey); } catch { /* Storage is optional. */ } }
        if (result.redirectTo) router.push(result.redirectTo);
        router.refresh();
      }, { failed: "Could not add these companies. Your homepages have been kept." });
    }}>
    {bulk ? <>
      <label className="grid gap-1.5"><span className={labelClass}>Company homepages, one per line</span>
        <textarea name="urls" required rows={5} maxLength={6000} value={urls} onChange={event => remember(event.target.value)}
          placeholder={"https://acme.com\nhttps://example.org"} className={`resize-y ${inputClass}`} />
      </label>
      <p className="text-12 text-muted">Up to 25 homepages. Existing companies are followed, and skipped addresses are reported. Your whole list is checked against your company allowance before anything is added.</p>
    </> : <span className="text-14"><span className="font-semibold">{domain}</span> <span className="text-muted">is not in the catalogue yet.</span></span>}
    <div><Button type="submit" variant="primary" size={bulk ? "md" : "sm"} className="min-h-11" disabled={!!blockedReason || call.busy}>
      {call.busy ? "Checking companies…" : bulk ? "Add company homepages" : `Add ${domain}`}
    </Button></div>
    {call.error && <p role="alert" className="basis-full text-13 text-danger">{call.error}</p>}
    {recovery && <a href={recovery.href} className="inline-flex min-h-11 items-center text-13 underline">{recovery.label}</a>}
  </form>;
}
