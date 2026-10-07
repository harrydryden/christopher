import { dismissSetupChecklist } from "@/app/actions/setup";
import { setupMilestones, type SetupChecklist as Checklist } from "@/lib/setup";

/** A compact next action first; the full checklist is available without occupying a phone screen. */
export function SetupChecklist({ checklist, variant }: { checklist: Checklist; variant: "explanation" | "card" }) {
  const explanation = variant === "explanation";
  const next = checklist.nextStep;
  const firstUse = explanation && !checklist.steps.some(step => step.id === "companies" && step.done);
  const monitoringStart = next?.id === "email" ? next : { href: checklist.notice.href, label: checklist.notice.action };
  return <section aria-label="Setup" className="mb-4 space-y-3 border-b-2 border-line-muted pb-4">
    {explanation && <div role="status" className="space-y-1">
      <h2 className="text-16 font-semibold">{checklist.notice.title}</h2>
      <p className="max-w-3xl text-14 text-muted">{checklist.notice.description}</p>
      {!firstUse && <a href={checklist.notice.href} className="inline-flex min-h-11 items-center text-14 font-semibold underline">{checklist.notice.action}</a>}
    </div>}
    {firstUse && <div className="grid gap-2 sm:grid-cols-2">
      <a href={monitoringStart.href} className="flex min-h-11 flex-col justify-center border-2 border-line px-3 py-2 text-14 no-underline hover:bg-sunken">
        <span className="font-semibold">Find roles at companies I follow</span>
        <span className="text-12 text-muted">{monitoringStart.label}</span>
      </a>
      <a href="/roles/add" className="flex min-h-11 flex-col justify-center border-2 border-line-muted px-3 py-2 text-14 no-underline hover:bg-sunken">
        <span className="font-semibold">I already have a role</span>
        <span className="text-12 text-muted">Add a job link or PDF.</span>
      </a>
    </div>}
    {!checklist.complete && <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-14"><span className="font-semibold">{explanation ? "Start here" : "Monitoring setup"}</span> · {checklist.summary}</p>
        {!explanation && <form action={dismissSetupChecklist}><button type="submit" className="min-h-11 px-2 text-13 text-muted underline">Hide setup</button></form>}
      </div>
      {next && <p className="text-14"><a href={next.href} className="font-semibold underline">{next.label}</a> · <span className="text-muted">{next.description}</span></p>}
      <details className="text-13 text-muted">
        <summary className="min-h-11 cursor-pointer py-3">All setup steps</summary>
        <ol className="grid gap-2 sm:grid-cols-2">
          {setupMilestones(checklist).map(step => <li key={step.id}>
            <a href={step.href} aria-current={step.state === "current" ? "step" : undefined} className="flex min-h-11 items-center gap-2 underline">
              <span aria-hidden="true">{step.done ? "✓" : "○"}</span>
              <span>{step.label}<span className="sr-only">, {step.done ? "done" : "to do"}</span></span>
            </a>
          </li>)}
        </ol>
        <p className="mt-2">Optional: <a href="/settings#seed-profile">describe your ideal work</a> to improve ranking; <a href="/library">prepare your evidence Library</a> when you want to build a CV.</p>
      </details>
    </>}
  </section>;
}
