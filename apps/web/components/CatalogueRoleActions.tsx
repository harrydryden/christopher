"use client";

import { useState } from "react";
import Link from "next/link";
import { decideCatalogueRecommendation } from "@/app/actions/recommendations";
import { Button } from "./Button";
import { useActionCall } from "./useActionCall";

export function CatalogueRoleActions({ jobId, title }: { jobId: string; title: string }) {
  const { busy, pending, error, setError, run } = useActionCall<"apply" | "skip">();
  const [saved, setSaved] = useState<"apply" | "skip" | null>(null);
  function choose(decision: "apply" | "skip") {
    run(decision, async () => {
      const result = await decideCatalogueRecommendation(jobId, decision);
      if (result.ok) setSaved(decision); else setError(result.error);
    }, { failed: "Could not save. Try again." });
  }
  if (saved) return <span role="status" className="text-12 text-muted">{saved === "apply" ? <Link prefetch={false} href="/?view=user-shortlisted" className="underline">Shortlisted · Open roles</Link> : "Dismissed"}</span>;
  return <div className="flex flex-wrap items-center gap-2">
    {(["apply", "skip"] as const).map(decision => {
      const label = decision === "apply" ? "Shortlist" : "Dismiss";
      return <Button key={decision} size="sm" variant={decision === "apply" ? "secondary" : "ghost"} disabled={busy}
        onClick={() => choose(decision)} aria-label={`${label} ${title}`}>
        {pending === decision ? "Saving…" : label}
      </Button>;
    })}
    {error && <p role="alert" className="basis-full text-12 text-danger">{error}</p>}
  </div>;
}
