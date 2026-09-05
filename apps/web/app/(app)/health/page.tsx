import Link from "next/link";
import { retryTask } from "@/app/actions/health";
import { Badge, companyStatusTone, jobStatusTone, scanStatusTone, sourceStatusTone, taskStatusTone } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { formatUsd, relativeTime } from "@/lib/format";
import {
  getAiSpendThisMonth,
  getQueueCounts,
  listCompaniesWithNoSource,
  listFailedTasks,
  listRecentAiCalls,
  listRecentProblemScans,
  listRecentScanRuns,
  listSourcesNeedingAttention,
} from "@/lib/queries/health";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function HealthPage() {
  const now = new Date();
  const [attentionSources, noSourceCompanies, problemScans, failedTasks, queueCounts, spend, aiCalls, scanRuns, settings] = await Promise.all([
    listSourcesNeedingAttention(),
    listCompaniesWithNoSource(),
    listRecentProblemScans(7),
    listFailedTasks(50),
    getQueueCounts(),
    getAiSpendThisMonth(now),
    listRecentAiCalls(20),
    listRecentScanRuns(10),
    getSettings(),
  ]);

  const budget = settings.monthlyAiBudgetUsd;
  const spendFraction = budget > 0 ? spend / budget : 0;
  const overBudget = budget > 0 && spend > budget;

  return (
    <div className="space-y-6">
      <PageHeader title="Health" description="Everything that needs your attention lives here." />

      <Card title={`Sources needing attention (${attentionSources.length + noSourceCompanies.length})`}>
        {attentionSources.length === 0 && noSourceCompanies.length === 0 ? (
          <EmptyState title="Nothing needs attention" description="Every source is active and every company has one." />
        ) : (
          <ul className="space-y-2 text-sm">
            {attentionSources.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2">
                <Badge tone={sourceStatusTone(s.status)}>{s.status === "needs_confirmation" ? "needs confirmation" : s.status}</Badge>
                <Link href={`/companies/${s.companyId}`} className="font-medium text-slate-800 hover:underline dark:text-slate-200">
                  {s.companyName}
                </Link>
                <span className="text-xs text-slate-400">{s.type}</span>
              </li>
            ))}
            {noSourceCompanies.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <Badge tone="red">no source</Badge>
                <Link href={`/companies/${c.id}`} className="font-medium text-slate-800 hover:underline dark:text-slate-200">
                  {c.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Recent problem scans (last 7 days, ${problemScans.length})`}>
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
                  <TD>
                    <Link href={`/companies/${p.companyId}`} className="hover:underline">
                      {p.companyName}
                    </Link>
                  </TD>
                  <TD>{p.sourceType}</TD>
                  <TD>
                    <Badge tone={scanStatusTone(p.scan.status)}>{p.scan.status}</Badge>
                  </TD>
                  <TD className="whitespace-nowrap" title={p.scan.startedAt.toISOString()}>
                    {relativeTime(p.scan.startedAt, now)}
                  </TD>
                  <TD className="max-w-[20rem] truncate text-red-600 dark:text-red-400" title={p.scan.error ?? undefined}>
                    {p.scan.error ?? ""}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
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
                  <TD>
                    <Badge tone="neutral">{t.type}</Badge>
                  </TD>
                  <TD className="max-w-[24rem] truncate text-red-600 dark:text-red-400" title={t.error ?? undefined}>
                    {t.error ?? ""}
                  </TD>
                  <TD className="whitespace-nowrap">{t.finishedAt ? relativeTime(t.finishedAt, now) : "—"}</TD>
                  <TD>{t.attempts}</TD>
                  <TD>
                    <form action={retryTask.bind(null, t.id)}>
                      <Button type="submit" size="sm">
                        Retry
                      </Button>
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
              <div key={`${c.type}-${c.status}`} className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-xs dark:border-slate-800">
                <span className="text-slate-500 dark:text-slate-400">{c.type}</span>
                <Badge tone={taskStatusTone(c.status)}>{c.status}</Badge>
                <span className="font-medium text-slate-800 dark:text-slate-200">{c.n}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="AI spend this month">
        <div className="mb-2 flex items-baseline gap-2">
          <span className="text-lg font-semibold text-slate-900 dark:text-slate-100">{formatUsd(spend)}</span>
          <span className="text-sm text-slate-400">of {formatUsd(budget)} budget</span>
        </div>
        <div className="mb-3 h-2 w-full overflow-hidden rounded-full bg-slate-150 dark:bg-slate-800">
          <div className={`h-full rounded-full ${overBudget ? "bg-red-500" : "bg-emerald-500"}`} style={{ width: `${Math.min(100, Math.max(2, spendFraction * 100))}%` }} />
        </div>
        {overBudget && <p className="mb-3 text-sm text-red-600 dark:text-red-400">Over budget — non-essential AI calls (near-miss scoring, then suggestions) are being skipped.</p>}
        <details>
          <summary className="cursor-pointer select-none text-sm text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100">Last {aiCalls.length} calls</summary>
          {aiCalls.length === 0 ? (
            <p className="mt-2 text-sm text-slate-400">No AI calls recorded yet.</p>
          ) : (
            <Table className="mt-2">
              <THead>
                <tr>
                  <TH>Call site</TH>
                  <TH>Model</TH>
                  <TH>Tokens (in/out)</TH>
                  <TH>Cost</TH>
                  <TH>When</TH>
                  <TH>OK</TH>
                </tr>
              </THead>
              <TBody>
                {aiCalls.map((c) => (
                  <TR key={c.id}>
                    <TD>{c.callSite}</TD>
                    <TD>{c.model}</TD>
                    <TD>
                      {c.inputTokens} / {c.outputTokens}
                    </TD>
                    <TD>{formatUsd(c.costUsd)}</TD>
                    <TD className="whitespace-nowrap" title={c.at.toISOString()}>
                      {relativeTime(c.at, now)}
                    </TD>
                    <TD>{c.ok ? <Badge tone="green">ok</Badge> : <Badge tone="red" title={c.error ?? undefined}>failed</Badge>}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </details>
      </Card>

      <Card title="Recent scan runs">
        {scanRuns.length === 0 ? (
          <EmptyState title="No scan runs yet" description="Daily runs appear here once the schedule starts, or after Run daily scan now on Settings." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Started</TH>
                <TH>Trigger</TH>
                <TH>Companies</TH>
                <TH>New / Closed</TH>
              </tr>
            </THead>
            <TBody>
              {scanRuns.map((r) => (
                <TR key={r.id}>
                  <TD className="whitespace-nowrap" title={r.startedAt.toISOString()}>
                    {relativeTime(r.startedAt, now)}
                  </TD>
                  <TD>
                    <Badge tone="neutral">{r.trigger}</Badge>
                  </TD>
                  <TD>
                    {r.companiesOk} ok
                    {r.companiesFailed > 0 && <span className="text-red-600 dark:text-red-400"> · {r.companiesFailed} failed</span>} of {r.companiesTotal}
                  </TD>
                  <TD>
                    {r.newRoles} / {r.closedRoles}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
