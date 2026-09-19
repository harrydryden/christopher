import { Badge } from "./Badge";
import { ElapsedTime } from "./ElapsedTime";
import { formatStepDuration } from "@/lib/format";
import { companySetupLine, type CompanyTimelineStep } from "@/lib/company-timeline";

/** The glyph says nothing to a screen reader; this is what it means. */
const SPOKEN: Record<CompanyTimelineStep["status"], string> = {
  waiting: "not started",
  running: "in progress",
  done: "done",
  attention: "needs you",
  failed: "failed",
};

/** The elapsed figure, ticking while the step is open and fixed once it has closed. */
function Elapsed({ step }: { step: CompanyTimelineStep }) {
  if (step.elapsedMs === null) return null;
  if (step.running && step.startedAt) {
    return (
      <span className="text-muted">
        {" · "}
        <ElapsedTime sinceMs={step.startedAt.getTime()} initialMs={step.elapsedMs} />
      </span>
    );
  }
  return <span className="text-muted"> · {formatStepDuration(step.elapsedMs)}</span>;
}

/**
 * Setting a company up, motion by motion, in the shape of the CV build narrative: one line per
 * step, the figures the rows recorded, and — while a step is open — how long it has been open and
 * how long it usually takes. The whole of it is derived in `lib/company-timeline.ts`.
 */
export function CompanySetupTimeline({ steps }: { steps: CompanyTimelineStep[] }) {
  return (
    <ol aria-label="Setup progress" className="space-y-0.5">
      {steps.map((step) => (
        <li key={step.key} className="text-14">
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 py-1">
            <Badge tone={step.tone} title={SPOKEN[step.status]}>
              <span aria-hidden="true">{step.glyph}</span>
              <span className="sr-only">{SPOKEN[step.status]}</span>
            </Badge>
            <div className="min-w-0 space-y-0.5">
              <p className="break-words">
                {step.text}
                <Elapsed step={step} />
                {step.running && step.expected && <span className="text-muted"> · {step.expected}</span>}
              </p>
              {step.note && (
                <p className={`text-12 break-words ${step.status === "failed" ? "text-danger" : "text-muted"}`}>{step.note}</p>
              )}
              <p className="ds-label">{step.label}</p>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * The same timeline once the company is set up: one line saying where it got to, which opens onto
 * the steps behind it. Nobody needs four lines about a company that is quietly working, and
 * "Scanned 2,331 postings · 4 match your filters · scoring" is the answer to "is it doing
 * anything?" without one.
 */
export function CompanySetupSummary({ steps }: { steps: CompanyTimelineStep[] }) {
  return (
    <details className="border-2 border-line-muted px-3 py-2">
      <summary className="cursor-pointer text-12 text-muted">
        <span className="text-fg">{companySetupLine(steps)}</span> · how this company was set up
      </summary>
      <div className="mt-2 border-t-2 border-line-faint pt-2">
        <CompanySetupTimeline steps={steps} />
      </div>
    </details>
  );
}
