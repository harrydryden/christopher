import { Badge } from "./Badge";
import { CvDisclosure } from "./CvDisclosure";
import type { NarratedBatch, NarratedStep, NarratedStatus, NarrativeItem } from "@/lib/cv-build-narrative";

/** The glyph says nothing to a screen reader; this is what it means. */
const SPOKEN: Record<NarratedStatus, string> = {
  running: "in progress",
  done: "done",
  failed: "failed",
  skipped: "skipped",
  interrupted: "interrupted",
};

function Line({ line, nested = false }: { line: NarratedStep; nested?: boolean }) {
  return (
    <div className={`grid grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 py-1 ${nested ? "pl-4" : ""}`}>
      <span className="text-12 text-muted">{line.time}</span>
      <Badge tone={line.tone} title={SPOKEN[line.status]}>
        <span aria-hidden="true">{line.glyph}</span>
        <span className="sr-only">{SPOKEN[line.status]}</span>
      </Badge>
      <div className="min-w-0 space-y-0.5">
        <p className="break-words" title={line.hint ?? undefined}>
          {line.text}
          {line.meta && <span className="text-muted"> · {line.meta}</span>}
        </p>
        {line.note && <p className={`text-12 break-words ${line.status === "failed" ? "text-danger" : "text-muted"}`}>{line.note}</p>}
        {!nested && <p className="ds-label">{line.stage}</p>}
      </div>
    </div>
  );
}

function Batch({ batch }: { batch: NarratedBatch }) {
  return (
    <li>
      <Line line={batch.line} nested />
      {batch.retries.length > 0 && (
        <ul aria-label="Re-checks of this batch" className="pl-4">
          {batch.retries.map((retry) => (
            <li key={retry.key}>
              <Line line={retry} nested />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * A build's motions as they happen, newest last: one line each, present tense while a motion is
 * open and past tense once it has closed, with the figures it recorded and what it cost.
 *
 * The items come from `narrateBuild`, which divides the attempts and gathers each pass of the
 * assessment into one row: the batches run together, so their lines sit behind a disclosure under
 * a row that counts them, except a batch that failed or was stopped, which is always in view.
 */
export function CvBuildNarrative({ items }: { items: NarrativeItem[] }) {
  if (!items.length) return null;
  return (
    <ol aria-label="Build narrative" className="space-y-0.5">
      {items.map((item) => {
        if (item.kind === "divider")
          return (
            <li key={item.key} className="text-14">
              <p className="ds-divider ds-pixel mt-3 pb-2 text-10 text-muted">{item.label}</p>
            </li>
          );
        if (item.kind === "line")
          return (
            <li key={item.key} className="text-14">
              <Line line={item.line} />
            </li>
          );
        const { group } = item;
        const quiet = group.batches.filter((batch) => !group.flagged.includes(batch));
        return (
          <li key={item.key} className="text-14">
            <Line line={group.line} />
            {group.flagged.length > 0 && (
              <ul aria-label="Batches that stopped" className="pl-4">
                {group.flagged.map((batch) => (
                  <Batch key={batch.line.key} batch={batch} />
                ))}
              </ul>
            )}
            {quiet.length > 0 && (
              <div className="pl-4">
                <CvDisclosure label={`${quiet.length === 1 ? "the batch" : `${quiet.length} batches`}`}>
                  <ul aria-label="Assessment batches">
                    {quiet.map((batch) => (
                      <Batch key={batch.line.key} batch={batch} />
                    ))}
                  </ul>
                </CvDisclosure>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
