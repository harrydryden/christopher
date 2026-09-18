import { workloadMetrics } from "@christopher/db";
import { aiBudgetWindowStart } from "@christopher/core";
import { users } from "@christopher/db/schema";
import Link from "next/link";
import { retryTask } from "@/app/actions/health";
import { Badge, scanStatusTone, sourceStatusTone, taskStatusTone } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { totalAiUsage } from "@/lib/ai-usage";
import { formatBytes, formatCount, formatDuration, formatUsd, relativeTime, shortDate } from "@/lib/format";
import { heapSummary, workerStateTone, HEAP_WARN_FRACTION } from "@/lib/worker-status";
import {
  getAiUsage,
  getLastCrashRecovery,
  getQueueCounts,
  getTotalAiSpend,
  getWorkerStatus,
  listCompaniesWithNoSource,
  listFailedTasks,
  listLargestScanInputs,
  listRecentProblemScans,
  listRecentScanRuns,
  listRecentWorkerEvents,
  listRetryingTasks,
  listRunningTasks,
  listSourcesNeedingAttention,
} from "@/lib/queries/health";

export const dynamic = "force-dynamic";

/** The three states, in the words the status line uses. */
const WORKER_STATE_LABEL = { healthy: "healthy", restarting: "restarting", stopped: "stopped" } as const;

const WORKER_EVENT_TONE: Partial<Record<string, "green" | "blue" | "amber" | "red" | "neutral">> = {
  boot: "blue",
  shutdown: "neutral",
  crash_recovery: "red",
  task_abandoned: "amber",
  task_deadline: "amber",
  holds_released: "neutral",
  vitals: "neutral",
};

export default async function AdminOperationsPage() {
  await requireAdmin();
  const now = new Date();
  // Budgets belong to accounts and each has its own window; this page is the deployment's report,
  // so it counts the calendar month that everybody's budget resets on.
  const since = aiBudgetWindowStart(now, null);
  const [metrics, status, crash, running, retrying, events, largestInputs, attentionSources, noSourceCompanies, problemScans, failedTasks, queueCounts, spend, usage, scanRuns, accounts] = await Promise.all([
    workloadMetrics(db()),
    getWorkerStatus(now),
    getLastCrashRecovery(),
    listRunningTasks(25),
    listRetryingTasks(25),
    listRecentWorkerEvents(30),
    listLargestScanInputs(7, 10),
    listSourcesNeedingAttention(),
    listCompaniesWithNoSource(),
    listRecentProblemScans(undefined, 7),
    listFailedTasks(50),
    getQueueCounts(),
    getTotalAiSpend(since),
    getAiUsage(since),
    listRecentScanRuns(10),
    db().select({ id: users.id, email: users.email }).from(users),
  ]);
  const emailById = new Map(accounts.map((a) => [a.id, a.email]));
  const totals = totalAiUsage(usage);
  const accountName = (userId: string | null) => (userId ? emailById.get(userId) ?? userId : "Shared");
  const heartbeat = status.heartbeat;

  return (
    <div className="space-y-6">
      <PageHeader title="Operations" description="Everything the shared worker is doing, across every account and every company in the catalogue." />

      <Card
        title="Background worker"
        actions={<Badge tone={workerStateTone(status.state)}>{WORKER_STATE_LABEL[status.state]}</Badge>}
      >
        <p className="text-14">
          {status.state === "stopped"
            ? `No worker report${heartbeat ? ` for ${Math.max(1, Math.round((status.ageMs ?? 0) / 60_000))} minutes` : " at all"}. Check that the background worker is deployed, running and connected to this database; queued scans and CVs are not moving.`
            : status.state === "restarting"
              ? `The worker is being restarted: ${status.restartsLastHour} crash recoveries in the last hour. A heartbeat is written on every boot, so "reported ${relativeTime(heartbeat?.at ?? now, now)}" here means a fresh process, not a healthy one.`
              : `Worker reported ${relativeTime(heartbeat?.at ?? now, now)}.`}
        </p>
        <p className="mt-2 text-14">
          {status.restartsLastDay === 0
            ? "No crash recoveries in the last 24 hours."
            : `${status.restartsLastDay} crash ${status.restartsLastDay === 1 ? "recovery" : "recoveries"} in the last 24 hours, ${status.restartsLastHour} in the last hour.`}
          {heartbeat?.bootedAt && <> Up {formatDuration(now.getTime() - heartbeat.bootedAt.getTime())} since its last boot.</>}
        </p>
        {heartbeat?.vitals ? (
          <p className={`mt-2 text-14 ${status.heapPressure ? "text-warn" : ""}`}>
            {heapSummary(heartbeat.vitals)}; {heartbeat.vitals.rssMb} MB resident, {heartbeat.vitals.externalMb} MB outside the heap.
            {status.heapPressure
              ? ` At or above ${Math.round(HEAP_WARN_FRACTION * 100)}% the next large input is likely to end the process, which no handler can catch or report.`
              : " V8 kills the process when the heap reaches its ceiling, so this is the number that predicts a restart."}
          </p>
        ) : (
          <p className="mt-2 text-14 text-muted">This worker has not reported a memory reading; deploy a release that sends vitals with its heartbeat.</p>
        )}
        {heartbeat && <p className="mt-2 text-14 text-muted">
          {heartbeat.workerId && <>Worker <code>{heartbeat.workerId}</code>. </>}
          {heartbeat.commit && <>Release <code>{heartbeat.commit.slice(0, 7)}</code>. </>}
          {heartbeat.concurrency !== null && <>{heartbeat.concurrency} slots. </>}
          {heartbeat.active !== null && <>{heartbeat.active} tasks active at the last report. </>}
          Anthropic key {heartbeat.aiConfigured ? "configured" : "missing"}; browser {heartbeat.browserAvailable ? "available" : "unavailable"}. A configured key still needs a successful model call to confirm access.
        </p>}
        <p className="mt-2 text-14">{metrics.ready} tasks ready · {metrics.running} running · oldest ready task waiting {Math.round(metrics.oldest_seconds / 60)} minutes.</p>
        <p className="mt-2 text-14">95% of completed tasks in the last day took at most {Math.round(metrics.p95_seconds)} seconds. {metrics.overdueCompanies} companies have no successful scan in 24 hours; {metrics.overdueDiscovery} discovery sources are over a day late.</p>
        <p className="mt-2 text-14">{formatUsd(metrics.reservedUsd)} is held by calls in flight, against the budgets of the accounts that asked for them.</p>
      </Card>

      <Card title="Last crash recovery">
        {!crash ? (
          <EmptyState title="No crash recovery recorded" description="The worker records one of these whenever it boots and finds tasks another process was still holding. An empty list is the good case." />
        ) : (
          <>
            <p className="text-14">
              {relativeTime(crash.at, now)}, worker <code>{crash.workerId}</code> booted and found {crash.suspects.length} {crash.suspects.length === 1 ? "task" : "tasks"} still claimed by a process that had gone. A crash is not a failure, so these attempts were handed back rather than counted against the task.
            </p>
            {crash.suspects.length > 0 && (
              <Table className="mt-3">
                <THead>
                  <tr>
                    <TH>Task</TH>
                    <TH>Subject</TH>
                    <TH className="text-right">Attempts</TH>
                    <TH>Claimed</TH>
                    <TH>By</TH>
                  </tr>
                </THead>
                <TBody>
                  {crash.suspects.map((suspect, i) => (
                    <TR key={suspect.id ?? i}>
                      <TD className="whitespace-nowrap">
                        <Badge tone="neutral">{suspect.type ?? "unknown"}</Badge>
                        {suspect.likely && <span className="ml-2 text-12 text-danger">likely cause</span>}
                      </TD>
                      <TD className="max-w-[22rem] truncate" title={suspect.subject ?? undefined}>{suspect.subject ?? "—"}</TD>
                      <TD className="text-right">{suspect.attempts ?? "—"}</TD>
                      <TD className="whitespace-nowrap">{suspect.lockedAt ? relativeTime(suspect.lockedAt, now) : "—"}</TD>
                      <TD className="max-w-[12rem] truncate" title={suspect.lockedBy ?? undefined}>{suspect.lockedBy ?? "—"}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </>
        )}
      </Card>

      <Card title={`Running tasks (${running.length})`}>
        {running.length === 0 ? (
          <EmptyState title="Nothing is running" description="Tasks claimed by a worker appear here with how long they have left before they are abandoned." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Type</TH>
                <TH>Subject</TH>
                <TH>Started</TH>
                <TH>Elapsed / deadline</TH>
                <TH className="text-right">Attempt</TH>
                <TH>Worker</TH>
              </tr>
            </THead>
            <TBody>
              {running.map((task) => {
                const elapsed = task.startedAt ? now.getTime() - task.startedAt.getTime() : null;
                const over = elapsed !== null && elapsed > task.deadlineMs;
                return (
                  <TR key={task.id}>
                    <TD><Badge tone="blue">{task.type}</Badge></TD>
                    <TD className="max-w-[22rem] truncate" title={task.subject ?? undefined}>{task.subject ?? "—"}</TD>
                    <TD className="whitespace-nowrap">{task.startedAt ? relativeTime(task.startedAt, now) : "—"}</TD>
                    <TD className={`whitespace-nowrap ${over ? "text-danger" : ""}`}>
                      {elapsed === null ? "—" : formatDuration(elapsed)} / {formatDuration(task.deadlineMs)}
                    </TD>
                    <TD className="text-right">{task.attempts} of {task.maxAttempts}</TD>
                    <TD className="max-w-[12rem] truncate" title={task.lockedBy ?? undefined}>{task.lockedBy ?? "—"}</TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>

      <Card title={`Retrying tasks (${retrying.length})`}>
        {retrying.length === 0 ? (
          <EmptyState title="Nothing is being retried" description="Queued tasks that have already been tried once and carry an error appear here — the ones a crash or a deadline handed back." />
        ) : (
          <>
            <p className="mb-3 text-14 text-muted">A queued task with attempts already spent was handed back by a worker. A long list of these, all naming the same company or CV, is a task the worker cannot survive rather than a queue that is busy.</p>
            <Table>
              <THead>
                <tr>
                  <TH>Type</TH>
                  <TH>Subject</TH>
                  <TH className="text-right">Attempt</TH>
                  <TH>Next run</TH>
                  <TH>Error</TH>
                </tr>
              </THead>
              <TBody>
                {retrying.map((task) => (
                  <TR key={task.id}>
                    <TD><Badge tone={taskStatusTone("queued")}>{task.type}</Badge></TD>
                    <TD className="max-w-[20rem] truncate" title={task.subject ?? undefined}>{task.subject ?? "—"}</TD>
                    <TD className={`text-right ${task.attempts >= task.maxAttempts ? "text-danger" : ""}`}>{task.attempts} of {task.maxAttempts}</TD>
                    <TD className="whitespace-nowrap">{relativeTime(task.runAfter, now)}</TD>
                    <TD className="max-w-[24rem] truncate text-danger" title={task.error ?? undefined}>{task.error ?? ""}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </>
        )}
      </Card>

      <Card title="Recent worker events">
        {events.length === 0 ? (
          <EmptyState title="No worker events recorded" description="Boots, shutdowns, crash recoveries, abandoned tasks and released budget holds are recorded here." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>When</TH>
                <TH>Event</TH>
                <TH>Task</TH>
                <TH>Subject</TH>
                <TH>Detail</TH>
              </tr>
            </THead>
            <TBody>
              {events.map((event) => (
                <TR key={event.id}>
                  <TD className="whitespace-nowrap" title={event.at.toISOString()}>{relativeTime(event.at, now)}</TD>
                  <TD><Badge tone={WORKER_EVENT_TONE[event.kind] ?? "neutral"}>{event.kind.replace(/_/g, " ")}</Badge></TD>
                  <TD className="whitespace-nowrap text-muted">{event.taskType ?? "—"}</TD>
                  <TD className="max-w-[18rem] truncate" title={event.subject ?? undefined}>{event.subject ?? "—"}</TD>
                  <TD className="max-w-[24rem] truncate text-muted" title={event.detail ?? undefined}>{event.detail ?? ""}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card title="Largest scan inputs (last 7 days)">
        <p className="mb-3 text-14 text-muted">
          A scan holds the listing it fetched in memory while it extracts from it, against the heap ceiling shown under Background worker — so the pages at the top of this list are the ones that can end the process.
        </p>
        {largestInputs.length === 0 ? (
          <EmptyState title="No measured scan inputs" description="Scans record the size of what they fetched; a recent scan will populate this." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Company</TH>
                <TH>Source</TH>
                <TH className="text-right">Fetched</TH>
                <TH>When</TH>
              </tr>
            </THead>
            <TBody>
              {largestInputs.map((row) => (
                <TR key={row.sourceId}>
                  <TD><Link href={`/admin/catalogue?q=${encodeURIComponent(row.companyName)}`} className="hover:underline">{row.companyName}</Link></TD>
                  <TD>{row.sourceType}</TD>
                  <TD className={`text-right ${heartbeat?.vitals && row.bytes > heartbeat.vitals.heapLimitMb * 1_048_576 * 0.1 ? "text-warn" : ""}`}>{formatBytes(row.bytes)}</TD>
                  <TD className="whitespace-nowrap" title={row.at.toISOString()}>{relativeTime(row.at, now)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card title="AI spend this month">
        <div className="mb-2 flex items-baseline gap-2">
          <span className="text-16 font-semibold text-fg">{formatUsd(spend)}</span>
          <span className="text-14 text-muted">spent since {shortDate(since)}, across every account and the work no account asked for</span>
        </div>
        <p className="mb-3 text-14 text-muted">
          Spending is bounded per account: each has its own monthly budget, which it sets on Settings and which you can set for anyone in <Link href="/admin" className="text-fg underline">Accounts</Link>, where each account&apos;s own figure and window are shown. An account that has spent its month has its optional calls (company and filter suggestions) skipped until the 1st.
        </p>
        <section>
          <h3 className="text-14 text-muted">Usage by account, feature and model</h3>
          {usage.length === 0 ? (
            <p className="mt-2 text-14 text-muted">No AI calls recorded in this window.</p>
          ) : (
            <Table className="mt-2">
              <THead>
                <tr>
                  <TH>Account</TH>
                  <TH>Feature</TH>
                  <TH>Model</TH>
                  <TH className="text-right">Calls</TH>
                  <TH className="text-right">Failed</TH>
                  <TH className="text-right">Input</TH>
                  <TH className="text-right">Output</TH>
                  <TH className="text-right">Cache read</TH>
                  <TH className="text-right">Cache write</TH>
                  <TH className="text-right">Cost</TH>
                </tr>
              </THead>
              <TBody>
                {usage.map((row) => (
                  <TR key={row.key}>
                    <TD className="max-w-48 truncate" title={accountName(row.userId)}>{accountName(row.userId)}</TD>
                    <TD>{row.feature}</TD>
                    <TD>{row.model}</TD>
                    <TD className="text-right">{formatCount(row.calls)}</TD>
                    <TD className={`text-right ${row.failed > 0 ? "text-danger" : ""}`}>{formatCount(row.failed)}</TD>
                    <TD className="text-right">{formatCount(row.inputTokens)}</TD>
                    <TD className="text-right">{formatCount(row.outputTokens)}</TD>
                    <TD className="text-right">{formatCount(row.cacheReadTokens)}</TD>
                    <TD className="text-right">{formatCount(row.cacheWriteTokens)}</TD>
                    <TD className="text-right">{formatUsd(row.costUsd)}</TD>
                  </TR>
                ))}
                <TR className="bg-sunken">
                  <TD className="font-semibold" colSpan={3}>Total</TD>
                  <TD className="text-right font-semibold">{formatCount(totals.calls)}</TD>
                  <TD className="text-right font-semibold">{formatCount(totals.failed)}</TD>
                  <TD className="text-right font-semibold">{formatCount(totals.inputTokens)}</TD>
                  <TD className="text-right font-semibold">{formatCount(totals.outputTokens)}</TD>
                  <TD className="text-right font-semibold">{formatCount(totals.cacheReadTokens)}</TD>
                  <TD className="text-right font-semibold">{formatCount(totals.cacheWriteTokens)}</TD>
                  <TD className="text-right font-semibold">{formatUsd(totals.costUsd)}</TD>
                </TR>
              </TBody>
            </Table>
          )}
        </section>
      </Card>

      <Card title={`Failed tasks (${failedTasks.length})`}>
        {failedTasks.length === 0 ? (
          <EmptyState title="No failed tasks" description="Failed background tasks (scans, discovery, AI calls) show up here with a retry button." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Type</TH>
                <TH>Error</TH>
                <TH>Finished</TH>
                <TH>Attempts</TH>
                <TH />
              </tr>
            </THead>
            <TBody>
              {failedTasks.map((t) => (
                <TR key={t.id}>
                  <TD><Badge tone="neutral">{t.type}</Badge></TD>
                  <TD className="max-w-[24rem] truncate text-danger" title={t.error ?? undefined}>{t.error ?? ""}</TD>
                  <TD className="whitespace-nowrap">{t.finishedAt ? relativeTime(t.finishedAt, now) : "—"}</TD>
                  <TD>{t.attempts}</TD>
                  <TD>
                    <form action={retryTask.bind(null, t.id)}>
                      <Button type="submit" size="sm">Retry</Button>
                    </form>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card title="Queue">
        {queueCounts.length === 0 ? (
          <EmptyState title="Queue is empty" description="No tasks queued, running, done or failed." />
        ) : (
          <div className="flex flex-wrap gap-2">
            {queueCounts.map((c) => (
              <div key={`${c.type}-${c.status}`} className="flex items-center gap-1.5 border border-line-muted px-2 py-1 text-12">
                <span className="text-muted">{c.type}</span>
                <Badge tone={taskStatusTone(c.status)}>{c.status}</Badge>
                <span className="font-medium text-fg">{c.n}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={`Sources needing attention, whole catalogue (${attentionSources.length + noSourceCompanies.length})`}>
        {attentionSources.length === 0 && noSourceCompanies.length === 0 ? (
          <EmptyState title="Nothing needs attention" description="Every source is active and every company has one." />
        ) : (
          <ul className="space-y-2 text-14">
            {attentionSources.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2">
                <Badge tone={sourceStatusTone(s.status)}>{s.status === "needs_confirmation" ? "needs confirmation" : s.status}</Badge>
                <Link href={`/admin/catalogue?q=${encodeURIComponent(s.companyName)}`} className="font-medium text-fg hover:underline">{s.companyName}</Link>
                <span className="text-12 text-muted">{s.type}</span>
              </li>
            ))}
            {noSourceCompanies.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <Badge tone="red">no source</Badge>
                <Link href={`/admin/catalogue?q=${encodeURIComponent(c.name)}`} className="font-medium text-fg hover:underline">{c.name}</Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Recent problem scans, whole catalogue (last 7 days, ${problemScans.length})`}>
        {problemScans.length === 0 ? (
          <EmptyState title="No problem scans" description="Every scan in the last 7 days completed OK." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Company</TH>
                <TH>Source</TH>
                <TH>Status</TH>
                <TH>When</TH>
                <TH>Error</TH>
              </tr>
            </THead>
            <TBody>
              {problemScans.map((p) => (
                <TR key={p.scan.id}>
                  <TD><Link href={`/admin/catalogue?q=${encodeURIComponent(p.companyName)}`} className="hover:underline">{p.companyName}</Link></TD>
                  <TD>{p.sourceType}</TD>
                  <TD><Badge tone={scanStatusTone(p.scan.status)}>{p.scan.status}</Badge></TD>
                  <TD className="whitespace-nowrap" title={p.scan.startedAt.toISOString()}>{relativeTime(p.scan.startedAt, now)}</TD>
                  <TD className="max-w-[20rem] truncate text-danger" title={p.scan.error ?? undefined}>{p.scan.error ?? ""}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card title="Recent scan runs">
        {scanRuns.length === 0 ? (
          <EmptyState title="No scan runs yet" description="Daily runs appear here once the schedule starts, or after Run daily scan now on System settings." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Started</TH>
                <TH>Trigger</TH>
                <TH>Companies</TH>
                <TH>New postings / Closed</TH>
              </tr>
            </THead>
            <TBody>
              {scanRuns.map((r) => (
                <TR key={r.id}>
                  <TD className="whitespace-nowrap" title={r.startedAt.toISOString()}>{relativeTime(r.startedAt, now)}</TD>
                  <TD><Badge tone="neutral">{r.trigger}</Badge></TD>
                  <TD>
                    {r.companiesOk} successful
                    {r.companiesFailed > 0 && <span className="text-danger"> · {r.companiesFailed} incomplete or failed</span>} of {r.companiesTotal}
                    {!r.finishedAt && <span className="block text-12 text-muted">In progress</span>}
                    {r.historicalOnly && <span className="block text-12 text-muted">Stored summary; source detail unavailable</span>}
                  </TD>
                  <TD>{r.newRoles} / {r.closedRoles}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
