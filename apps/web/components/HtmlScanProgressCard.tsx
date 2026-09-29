import Link from "next/link";
import { Badge } from "@/components/Badge";
import { Card } from "@/components/Card";
import { relativeTime } from "@/lib/format";
import type { HtmlScanProgress } from "@/lib/queries/html-scan-progress";
import { interruptedHtmlRead } from "@/lib/queries/html-scan-progress";
import type { WorkerStatus } from "@/lib/worker-status";

function statusOf(item: HtmlScanProgress, worker: WorkerStatus, now: Date): { label: string; tone: "amber" | "red" | "blue"; next: string } {
  if (interruptedHtmlRead(item, now)) {
    return { label: "Interrupted", tone: "red", next: worker.state === "stopped" || worker.state === "restarting"
      ? "This read did not finish. An administrator must restore monitoring; then open the company and choose Rescan."
      : "This read did not finish. Open the company and choose Rescan." };
  }
  if (worker.state === "stopped" || worker.state === "restarting") {
    return { label: "Waiting for monitoring", tone: "amber", next: "Monitoring is interrupted. An administrator needs to restore the background worker before this read can continue." };
  }
  if (item.taskStatus === "queued") {
    const waiting = item.runAfter > now;
    return { label: "Waiting to continue", tone: "blue", next: waiting ? `The next read is scheduled ${relativeTime(item.runAfter, now)}.` : "This read is queued to continue. Refresh this page for progress." };
  }
  return { label: "Reading", tone: "blue", next: "The listing is being read. Refresh this page for progress." };
}

/** A stored page is progress, not a role result: reconciliation happens only after the full read. */
export function HtmlScanProgressCard({ items, worker, now }: { items: HtmlScanProgress[]; worker: WorkerStatus; now: Date }) {
  if (!items.length) return null;
  return <Card title={`Listing scan progress (${items.length})`}>
    <p className="mb-3 text-14 text-muted">A full listing check must finish before its job entries can appear in Roles.</p>
    <ul className="space-y-3">
      {items.map(item => {
        const status = statusOf(item, worker, now);
        return <li key={item.generationId} className="space-y-2 border-2 border-line-muted p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Link prefetch={false} href={`/companies/${item.companyId}`} className="text-14 font-semibold underline">{item.companyName}</Link>
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
          <p className="break-all text-12 text-muted">{item.sourceUrl}</p>
          <p className="text-14">{item.pagesRead} {item.pagesRead === 1 ? "page" : "pages"} read · {item.stagedPostings} job {item.stagedPostings === 1 ? "entry" : "entries"} read so far</p>
          <p className="text-14">{status.next}</p>
          {status.label === "Interrupted" && item.taskError && <p className="break-words text-12 text-danger">Recorded error: {item.taskError}</p>}
        </li>;
      })}
    </ul>
  </Card>;
}
