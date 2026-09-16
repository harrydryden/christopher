import { workloadMetrics } from "@christopher/db";
import { db } from "@/lib/db";
import Link from "next/link";
import { retryTask } from "@/app/actions/health";
import { Badge, scanStatusTone, sourceStatusTone, taskStatusTone } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { formatUsd, relativeTime } from "@/lib/format";
import {
  getAiSpendByAccount,
  getAiSpendThisMonth,
  getWorkerHeartbeat,
  getQueueCounts,
  listCompaniesWithNoSource,
  listFailedTasks,
  listRecentAiCalls,
  listRecentProblemScans,
  listRecentScanRuns,
  listSourcesNeedingAttention,
} from "@/lib/queries/health";
import { getSystemSettings } from "@/lib/settings";
import { requireUser } from "@/lib/auth";
import { users } from "@christopher/db/schema";

export const dynamic = "force-dynamic";

export default async function HealthPage() {
  const user = await requireUser();
  const admin = user.role === "admin";
  const scope = admin ? undefined : user.id;
  const now = new Date();
  const [attentionSources, noSourceCompanies, problemScans, scanRuns, settings, heartbeat] = await Promise.all([
    listSourcesNeedingAttention(scope),
    listCompaniesWithNoSource(scope),
    listRecentProblemScans(scope, 7),
    listRecentScanRuns(10, scope),
    getSystemSettings(),
    getWorkerHeartbeat(),
  ]);
  const [metrics, failedTasks, queueCounts, spend, spendByAccount, aiCalls, accounts] = admin
    ? await Promise.all([workloadMetrics(db()), listFailedTasks(50), getQueueCounts(), getAiSpendThisMonth(now), getAiSpendByAccount(now), listRecentAiCalls(20), db().select({ id: users.id, email: users.email }).from(users)])
    : [null, [], [], 0, [], [], []];
  const emailById = new Map(accounts.map(a => [a.id, a.email]));

  const budget = settings.monthlyAiBudgetUsd;
  const spendFraction = budget > 0 ? spend / budget : 0;
  const overBudget = budget > 0 && spend > budget;

  return (
    <div className="space-y-6">
      <PageHeader title="Health" description={admin ? "Everything the shared worker is doing, across every account." : "Sources and scans for the companies you follow. Administrators see the shared queue and AI spend."} />

      {admin && metrics && (
        <Card title="Processing capacity">
          <p className="text-14">{metrics.ready} tasks ready · {metrics.running} running · oldest ready task waiting {Math.round(metrics.oldest_seconds / 60)} minutes.</p>
          <p className="mt-2 text-14">95% of completed tasks in the last day took at most {Math.round(metrics.p95_seconds)} seconds. {metrics.overdueCompanies} companies have no successful scan in 24 hours; {metrics.overdueDiscovery} discovery sources are over a day late.</p>
          <p className="mt-2 text-14">AI requests currently reserve {formatUsd(metrics.reservedUsd)} against the shared budget.</p>
        </Card>
      )}
      <Card title="Background worker">
        <p className="text-14">
          {heartbeat && now.getTime() - heartbeat.at.getTime() < 120_000
            ? `Worker reported ${relativeTime(heartbeat.at, now)}.`
            : "No recent worker report. Check that the background worker is deployed, running and connected to this database; queued scans and CVs may be waiting."}
        </p>
        {heartbeat && <p className="mt-2 text-14 text-muted">
          Last reported configuration: Anthropic key {heartbeat.aiConfigured ? "configured" : "missing"}; browser {heartbeat.browserAvailable ? "available" : "unavailable"}. A configured key still needs a successful model call to confirm access. {heartbeat.commit && <>Worker release: <code>{heartbeat.commit.slice(0, 7)}</code>.</>}
        </p>}
      </Card>

      <p className="text-14 text-muted">Attention lists show up to 100 items each. Use Companies to browse the full portfolio.</p>
      <Card title={`Sources needing attention (${attentionSources.length + noSourceCompanies.length})`}>
        {attentionSources.length === 0 && noSourceCompanies.length === 0 ? (
          <EmptyState title="Nothing needs attention" description="Every source is active and every company has one." />
        ) : (
          <ul className="space-y-2 text-14">
            {attentionSources.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2">
                <Badge tone={sourceStatusTone(s.status)}>{s.status === "needs_confirmation" ? "needs confirmation" : s.status}</Badge>
                <Link href={`/companies/${s.companyId}`} className="font-medium text-fg hover:underline">
                  {s.companyName}
                </Link>
                <span className="text-12 text-muted">{s.type}</span>
              </li>
            ))}
            {noSourceCompanies.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <Badge tone="red">no source</Badge>
                <Link href={`/companies/${c.id}`} className="font-medium text-fg hover:underline">
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
                  <TD className="max-w-[20rem] truncate text-danger" title={p.scan.error ?? undefined}>
                    {p.scan.error ?? ""}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {admin && (
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
                    <TD className="max-w-[24rem] truncate text-danger" title={t.error ?? undefined}>
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
      )}

      {admin && (
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
      )}

      {admin && (
        <Card title="AI spend this month (shared)">
          <div className="mb-2 flex items-baseline gap-2">
            <span className="text-16 font-semibold text-fg">{formatUsd(spend)}</span>
            <span className="text-14 text-muted">of {formatUsd(budget)} budget</span>
          </div>
          <div className="mb-3 h-2 w-full overflow-hidden bg-track">
            <div className={`h-full ${overBudget ? "bg-danger" : "bg-ok"}`} style={{ width: `${Math.min(100, Math.max(2, spendFraction * 100))}%` }} />
          </div>
          {overBudget && <p className="mb-3 text-14 text-danger">Over budget — non-essential AI calls (near-miss scoring, then suggestions) are being skipped.</p>}
          {spendByAccount.length > 0 && (
            <ul className="mb-3 space-y-1 text-14">
              {spendByAccount.map((row) => (
                <li key={row.userId ?? "shared"} className="flex justify-between gap-3">
                  <span className="truncate text-muted">{row.userId ? emailById.get(row.userId) ?? row.userId : "Shared work (extraction, discovery, profiles)"}</span>
                  <span className="tabular-nums">{formatUsd(row.total)}</span>
                </li>
              ))}
            </ul>
          )}
          <section>
            <h3 className="text-14 text-muted hover:text-fg">Last {aiCalls.length} calls</h3>
            {aiCalls.length === 0 ? (
              <p className="mt-2 text-14 text-muted">No AI calls recorded yet.</p>
            ) : (
              <Table className="mt-2">
                <THead>
                  <tr>
                    <TH>Call site</TH>
                    <TH>Account</TH>
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
                      <TD className="max-w-[12rem] truncate">{c.userId ? emailById.get(c.userId) ?? "—" : "shared"}</TD>
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
          </section>
        </Card>
      )}

      <Card title="Recent scan runs">
        {scanRuns.length === 0 ? (
          <EmptyState title="No scan runs yet" description="Daily runs appear here once the schedule starts, or after an administrator presses Run daily scan now on Settings." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Started</TH>
                <TH>Trigger</TH>
                <TH>{admin ? "Companies" : "Your companies"}</TH>
                <TH>New postings / Closed</TH>
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
                    {r.companiesOk} successful
                    {r.companiesFailed > 0 && <span className="text-danger"> · {r.companiesFailed} incomplete or failed</span>} of {r.companiesTotal}
                    {!r.finishedAt && <span className="block text-12 text-muted">In progress</span>}
                    {r.historicalOnly && <span className="block text-12 text-muted">Stored summary; source detail unavailable</span>}
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
