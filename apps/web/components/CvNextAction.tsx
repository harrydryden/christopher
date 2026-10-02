"use client";

import type { cvNextAction } from "@/lib/cv-next-action";
import { buttonClass } from "@/components/Button";

/** The one sentence a person needs before opening the three workspace tabs. */
export function CvNextAction({ id, next }: { id: string; next: ReturnType<typeof cvNextAction> }) {
  const href = next.target === "download" ? `/api/cv/${id}/pdf` : next.target === "review" ? "#cv-guided-review" : `#cv-panel-${next.target}`;
  return <section className="flex flex-wrap items-center justify-between gap-3 border-2 border-line bg-raised p-4" aria-labelledby="cv-next-action">
    <div className="space-y-1">
      <h2 id="cv-next-action" className="font-mono text-14 font-semibold">Next action · {next.title}</h2>
      <p className="text-14 text-muted">{next.detail}</p>
    </div>
    <a href={href} onClick={() => {
      // A tab change can leave this same fragment in the URL; clicking it again must reopen review.
      if (href.startsWith("#") && window.location.hash === href) window.dispatchEvent(new HashChangeEvent("hashchange"));
    }} className={buttonClass("primary", "md", "no-underline")}>{next.action}</a>
  </section>;
}
