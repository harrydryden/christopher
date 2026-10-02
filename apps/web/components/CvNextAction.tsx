import type { cvNextAction } from "@/lib/cv-next-action";
import { buttonClass } from "@/components/Button";

/** The one sentence a person needs before opening the three workspace tabs. */
export function CvNextAction({ id, next }: { id: string; next: ReturnType<typeof cvNextAction> }) {
  const href = next.target === "download" ? `/api/cv/${id}/pdf` : `#cv-panel-${next.target}`;
  return <section className="flex flex-wrap items-center justify-between gap-3 border-2 border-line bg-raised p-4" aria-labelledby="cv-next-action">
    <div className="space-y-1">
      <h2 id="cv-next-action" className="font-mono text-14 font-semibold">Next action · {next.title}</h2>
      <p className="text-14 text-muted">{next.detail}</p>
    </div>
    <a href={href} className={buttonClass("primary", "md", "no-underline")}>{next.action}</a>
  </section>;
}
