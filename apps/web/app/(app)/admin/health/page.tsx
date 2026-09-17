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
import { formatCount, formatUsd, relativeTime, shortDate } from "@/lib/format";
import {
  getAiUsage,
  getQueueCounts,
  getSharedAiSpend,
  getWorkerHeartbeat,
  listCompaniesWithNoSource,
  listFailedTasks,
  listRecentProblemScans,
  listRecentScanRuns,
  listSourcesNeedingAttention,
} from "@/lib/queries/health";
import { getSystemSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function AdminOperationsPage() {
  await requireAdmin();
  const now = new Date();
  const settings = await getSystemSettings();
  // The shared counter is reset by moving its window, so both the bar and the report start here.
  const since = aiBudgetWindowStart(now, settings.aiBudgetResetAt);
  const monthStart = aiBudgetWindowStart(now, null);
  const [metrics, heartbeat, attentionSources, noSourceCompanies, problemScans, failedTasks, queueCounts, spend, usage, scanRuns, accounts] = await Promise.all([
    workloadMetrics(db()),
    getWorkerHeartbeat(),
    listSourcesNeedingAttention(),
    listCompaniesWithNoSource(),
    listRecentProblemScans(undefined, 7),
    listFailedTasks(50),
    getQueueCounts(),
    getSharedAiSpend(since),
    getAiUsage(since),
    listRecentScanRuns(10),
    db().select({ id: users.id, email: users.email }).from(users),
  ]);
  const emailById = new Map(accounts.map((a) => [a.id, a.email]));
  const budget = settings.monthlyAiBudgetUsd;
  const spendFraction = budget > 0 ? spend / budget : 0;
  const overBudget = budget > 0 && spend > budget;
  const totals = totalAiUsage(usage);
  const accountName = (userId: string | null) => (userId ? emailById.get(userId) ?? userId : "Shared");

  return (
    <div className="space-y-6">
      <PageHeader title="Operations" description="Everything the shared worker is doing, across every account and every company in the catalogue." />

      <Card title="Background worker">
        <p className="text-14">
          {heartbeat && now.getTime() - heartbeat.at.getTime() < 120_000
            ? `Worker reported ${relativeTime(heartbeat.at, now)}.`
            : "No recent worker report. Check that the background worker is deployed, running and connected to this database; queued scans and CVs may be waiting."}
        </p>
        {heartbeat && <p className="mt-2 text-14 text-muted">
          Last reported configuration: Anthropic key {heartbeat.aiConfigured ? "configured" : "missing"}; browser {heartbeat.browserAvailable ? "available" : "unavailable"}. A configured key still needs a successful model call to confirm access. {heartbeat.commit && <>Worker release: <code>{heartbeat.commit.slice(0, 7)}</code>.</>}
        </p>}
        <p className="mt-2 text-14">{metrics.ready} tasks ready · {metrics.running} running · oldest ready task waiting {Math.round(metrics.oldest_seconds / 60)} minutes.</p>
        <p className="mt-2 text-14">95% of completed tasks in the last day took at most {Math.round(metrics.p95_seconds)} seconds. {metrics.overdueCompanies} companies have no successful scan in 24 hours; {metrics.overdueDiscovery} discovery sources are over a day late.</p>
        <p className="mt-2 text-14">AI requests currently reserve {formatUsd(metrics.reservedUsd)} against the shared budget.</p>
      </Card>

      <Card title="AI spend this month">
        <div className="mb-2 flex items-baseline gap-2">
          <span className="text-16 font-semibold text-fg">{formatUsd(spend)}</span>
          <span className="text-14 text-muted">of {formatUsd(budget)} shared ceiling</span>
        </div>
        <div className="mb-3 h-2 w-full overflow-hidden bg-track">
          <div className={`h-full ${overBudget ? "bg-danger" : "bg-ok"}`} style={{ width: `${Math.min(100, Math.max(2, spendFraction * 100))}%` }} />
        </div>
        {overBudget && <p className="mb-3 text-14 text-danger">Over budget — non-essential AI calls (near-miss scoring, then suggestions) are being skipped.</p>}
        <p className="mb-3 text-14 text-muted">
          {since.getTime() > monthStart.getTime()
            ? `Counting since ${shortDate(since)}, the shared reset marker, rather than the start of the month.`
            : "Counting since the start of the month."}
          {" "}Every account also has its own budget, set in <Link href="/admin" className="text-fg underline">Accounts</Link>; this is the ceiling over all of them.
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
