"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { followCompany } from "@/app/actions/companies";
import { Button } from "@/components/Button";
import { Monogram } from "@/components/brand";

/** Follow one catalogue company from the Discover tab's search results, and say how it went in place. */
export function FollowCompanyButton({ companyId, companyName, label = "Follow", disabled = false }: { companyId: string; companyName: string; label?: string; disabled?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  function follow() {
    setResult(null);
    startTransition(async () => {
      try {
        const outcome = await followCompany(companyId);
        if (!outcome.ok) { setResult({ ok: false, text: outcome.error }); return; }
        setResult({ ok: true, text: outcome.message ?? `You now follow ${companyName}.` });
        router.refresh();
      } catch {
        setResult({ ok: false, text: "This change could not be completed. Please try again." });
      }
    });
  }
  if (result?.ok) return <p role="status" className="text-12 text-ok">{result.text}</p>;
  return (
    <span className="flex flex-wrap items-center justify-end gap-2">
      {pending && <Monogram size={16} searching title="Following" />}
      <Button size="sm" variant="primary" className="min-h-11" onClick={follow} disabled={disabled || pending} aria-label={`${label} ${companyName}`}>{label}</Button>
      {result && <span role="alert" className="basis-full text-right text-12 text-danger">{result.text}</span>}
    </span>
  );
}
