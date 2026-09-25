import { dismissSetupChecklist } from "@/app/actions/setup";
import { EMPTY_TABLE_SENTENCE, setupMilestones, type MilestoneState, type SetupChecklist as Checklist } from "@/lib/setup";

/** The square at each milestone: filled when done, outlined with a centre cell when current. */
function Marker({ state }: { state: MilestoneState }) {
  if (state === "done") return <span className="size-4 shrink-0 bg-fg" />;
  if (state === "current") {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center border-2 border-line">
        <span className="size-1 bg-fg" />
      </span>
    );
  }
  return <span className="size-4 shrink-0 border-2 border-line-muted" />;
}

const LABEL_TONE: Record<MilestoneState, string> = {
  done: "text-fg",
  current: "text-fg underline decoration-2 underline-offset-4",
  todo: "text-muted",
};

/**
 * The five steps of setting AVA up as one row of milestones, derived from rows rather than
 * remembered (Journey 1.1). Each milestone links to the field that finishes it; the line beneath
 * says why the current one matters.
 *
 * Two placements, one component. Above an empty table it is the page's explanation and cannot be
 * hidden, because a blank table is exactly what needs explaining; once roles are arriving it can be
 * hidden, which stores nothing but the moment it was hidden. Finished setup is never rendered: the
 * caller returns nothing once `complete` is true.
 */
export function SetupChecklist({ checklist, variant }: { checklist: Checklist; variant: "explanation" | "card" }) {
  const explanation = variant === "explanation";
  const milestones = setupMilestones(checklist);
  const next = checklist.nextStep;
  return (
    <section aria-label="Setup" className="mb-4 border-b-2 border-line-muted pb-3">
      {explanation && <p className="mb-3 text-14">{EMPTY_TABLE_SENTENCE}</p>}
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="ds-pixel text-10 text-muted">
          {explanation ? "Start here" : "Setup"} · {checklist.summary}
        </h2>
        {!explanation && (
          <form action={dismissSetupChecklist}>
            <button type="submit" className="text-12 text-muted underline hover:text-fg">
              Hide
            </button>
          </form>
        )}
      </div>
      <ol className="grid grid-cols-3 gap-y-3 md:grid-cols-5">
        {milestones.map((step, index) => (
          <li key={step.id} className="min-w-0">
            <a
              href={step.href}
              title={step.label}
              aria-current={step.state === "current" ? "step" : undefined}
              className="group flex min-h-11 flex-col gap-1.5 no-underline"
            >
              <span className="flex items-center" aria-hidden="true">
                <Marker state={step.state} />
                <span className={`h-0.5 flex-1 ${index === milestones.length - 1 ? "invisible" : step.done ? "bg-fg" : "bg-track"}`} />
              </span>
              <span className={`ds-pixel pr-2 text-10 group-hover:underline ${LABEL_TONE[step.state]}`}>
                {step.shortLabel}
                <span className="sr-only">: {step.label}, {step.state === "todo" ? "to do" : step.state}</span>
              </span>
              {step.progress && <span className="text-10 text-muted tabular-nums">{step.progress}</span>}
            </a>
          </li>
        ))}
      </ol>
      {next && (
        <p className="mt-2 text-12 text-muted">
          <a href={next.href} className="text-fg">
            {next.label}
          </a>
          {" · "}
          {next.description}
        </p>
      )}
    </section>
  );
}
