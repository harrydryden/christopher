"use client";
import { useState } from "react";
import { followCompany } from "@/app/actions/companies";
import { Button } from "@/components/Button";
import { Monogram } from "@/components/brand";
import { useActionCall } from "./useActionCall";

/** Follow one catalogue company from the Discover tab's search results, and say how it went in place. */
export function FollowCompanyButton({ companyId, companyName, label = "Follow", disabled = false }: { companyId: string; companyName: string; label?: string; disabled?: boolean }) {
  const { busy: pending, error, setError, run } = useActionCall();
  const [followed, setFollowed] = useState<string | null>(null);
  function follow() {
    run(true, async () => {
      const outcome = await followCompany(companyId);
      if (!outcome.ok) { setError(outcome.error); return; }
      setFollowed(outcome.message ?? `You now follow ${companyName}.`);
    }, { failed: "Could not save. Try again." });
  }
  if (followed) return <p role="status" className="text-12 text-ok">{followed}</p>;
  return (
    <span className="flex flex-wrap items-center justify-end gap-2">
      {pending && <Monogram size={16} searching title="Following" />}
      <Button size="sm" variant="primary" className="min-h-11" onClick={follow} disabled={disabled || pending} aria-label={`${label} ${companyName}`}>{label}</Button>
      {error && <span role="alert" className="basis-full text-right text-12 text-danger">{error}</span>}
    </span>
  );
}
