import Link from "next/link";
import { retryLocationCheck } from "@/app/actions/health";
import type { LocationChecks } from "@/lib/queries/location-health";
import type { WorkerStatus } from "@/lib/worker-status";
import { relativeTime } from "@/lib/format";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Card } from "./Card";
import { VERIFY_SENTENCE } from "./VerifyNotice";

export function LocationChecksCard({ checks, worker, now, unverified, companyOnly = false }: {
  checks: LocationChecks;
  worker: WorkerStatus;
  now: Date;
  unverified: boolean;
  companyOnly?: boolean;
}) {
  if (!checks.total) return null;
  const monitoringDown = worker.state === "stopped" || worker.state === "restarting";
  return <Card title={`Role locations to check (${checks.total})`}>
    <div aria-live="polite" className="space-y-3">
      <p className="text-14">
        Some careers listings show only the number of locations. We need the place names before checking these roles against your preferences. More matches may appear when the checks finish. Previously confirmed matches remain visible while we check again.
      </p>
      <p className="text-13 text-muted">
        {checks.pending} waiting for location details · {checks.unavailable} could not be checked yet.
        {monitoringDown && " Monitoring needs an administrator before queued checks can continue."}
      </p>
      <ul className="space-y-2">
        {checks.rows.map((row) => {
          const scheduled = row.taskStatus === "queued" && !!row.nextAttemptAt && row.nextAttemptAt > now;
          const nextTime = row.nextAttemptAt?.toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" });
          return <li key={row.jobId} className="flex flex-wrap items-center justify-between gap-2 border-t-2 border-line-faint pt-2">
          <div className="min-w-0 space-y-1">
            <p className="break-words text-14 font-medium">{row.title}</p>
            {!companyOnly && <Link prefetch={false} href={`/companies/${row.companyId}`} className="inline-block min-h-11 py-2 text-13 underline">{row.companyName}</Link>}
            <p className="text-12 text-muted">
              {row.taskActive
                ? monitoringDown ? "Waiting for monitoring to resume."
                  : scheduled ? <>Waiting before checking this careers site again. <time dateTime={row.nextAttemptAt!.toISOString()} title={`${nextTime} UK time`} aria-label={`Next check ${nextTime} UK time`}>Next check {relativeTime(row.nextAttemptAt, now)}.</time></>
                    : row.taskStatus === "running" ? "Location check is running." : "Location check is queued to start."
                : row.state === "unavailable" ? "Locations could not be read. You can try this check again."
                  : "Location check has not started. You can request it again."}
            </p>
          </div>
          {row.taskActive
            ? <Badge tone="blue">{monitoringDown ? "Waiting" : scheduled ? "Scheduled" : row.taskStatus === "running" ? "Checking" : "Waiting"}</Badge>
            : <form action={retryLocationCheck.bind(null, row.jobId)}>
                <Button type="submit" size="sm" disabled={unverified} title={unverified ? VERIFY_SENTENCE : undefined}>
                  {row.revision === null ? "Start location check" : "Retry location check"}
                </Button>
              </form>}
        </li>;
        })}
      </ul>
      {checks.total > checks.rows.length && <p className="text-12 text-muted">Showing the first {checks.rows.length} of {checks.total} checks. {companyOnly ? "This list updates as checks finish." : "Open an affected company for more checks."}</p>}
    </div>
  </Card>;
}
