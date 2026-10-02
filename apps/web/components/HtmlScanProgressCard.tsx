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

/** Partial publication never makes the listing a complete check. */
export function HtmlScanProgressCard({ items, worker, now }: { items: HtmlScanProgress[]; worker: WorkerStatus; now: Date }) {
  if (!items.length) return null;
  return <Card title={`Listing scan progress (${items.length})`}>
    <p className="mb-3 text-14 text-muted">Matching roles can appear before a long listing check finishes. An incomplete check cannot confirm that all roles have been seen.</p>
    <ul className="space-y-3">
      {items.map(item => {
        const status = statusOf(item, worker, now);
        const interrupted = interruptedHtmlRead(item, now);
        const monitoringStopped = worker.state === "stopped" || worker.state === "restarting";
        return <li key={item.generationId} className="space-y-2 border-2 border-line-muted p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Link prefetch={false} href={`/companies/${item.companyId}`} className="text-14 font-semibold underline">{item.companyName}</Link>
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
          <p className="break-all text-12 text-muted">{item.sourceUrl}</p>
          <p className="text-14">{item.pagesRead} {item.pagesRead === 1 ? "page" : "pages"} checked so far</p>
          <p className="text-14">{item.publishedPages > 0
            ? interrupted
              ? "You can review any matching roles already found in Roles. Rescan to check the remaining pages."
              : monitoringStopped
                ? "You can review any matching roles already found in Roles. Monitoring must resume before the remaining pages can be checked."
                : "You can review any matching roles found so far in Roles. The rest of the listing is still being checked."
            : interrupted
              ? "This read stopped before matching roles were ready. Rescan to check the listing again."
              : monitoringStopped
                ? "Matching roles can appear when monitoring resumes. This listing check is still incomplete."
                : "Matching roles will appear in Roles as results are ready. This listing check is still incomplete."}</p>
          {item.publishedPages > 0 && <Link prefetch={false} href="/" className="inline-block min-h-11 py-2 text-14 font-semibold underline">Review roles</Link>}
          <p className="text-14">{status.next}</p>
          {status.label === "Interrupted" && item.taskError && <p className="break-words text-12 text-danger">Recorded error: {item.taskError}</p>}
        </li>;
      })}
    </ul>
  </Card>;
}
