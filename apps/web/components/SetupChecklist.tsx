import { dismissSetupChecklist } from "@/app/actions/setup";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EMPTY_TABLE_SENTENCE, type SetupChecklist as Checklist } from "@/lib/setup";

/**
 * The five steps of setting AVA up, derived from rows rather than remembered (Journey 1.1).
 *
 * Two placements, one component. Above an empty table it is the page's explanation and cannot be
 * hidden, because a blank table is exactly what needs explaining; once roles are arriving it is a
 * card with a Hide, which stores nothing but the moment it was hidden.
 */
export function SetupChecklist({ checklist, variant }: { checklist: Checklist; variant: "explanation" | "card" }) {
  const explanation = variant === "explanation";
  return (
    <div className="mb-4">
      <Card
        title={explanation ? "Start here" : "Finish setting up"}
        actions={
          explanation ? undefined : (
            <form action={dismissSetupChecklist}>
              <Button type="submit" variant="ghost" size="sm">
                Hide
              </Button>
            </form>
          )
        }
      >
        {explanation && <p className="mb-3 text-14">{EMPTY_TABLE_SENTENCE}</p>}
        <p className="mb-3 text-12 text-muted">
          {checklist.summary}
          {checklist.nextStep && <> · next: {checklist.nextStep.label}</>}
        </p>
        <ol className="flex flex-col">
          {checklist.steps.map((step) => (
            <li key={step.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line-faint py-2 first:border-t-0 first:pt-0 last:pb-0">
              <Badge tone={step.done ? "green" : "gray"}>{step.done ? "done" : "to do"}</Badge>
              <a href={step.href} className="text-14 text-fg">
                {step.label}
              </a>
              {step.progress && <span className="text-12 text-muted tabular-nums">{step.progress}</span>}
              <span className="basis-full text-12 text-muted">{step.description}</span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
