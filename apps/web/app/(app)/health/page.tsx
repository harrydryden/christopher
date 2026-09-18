import Link from "next/link";
import { Badge, scanStatusTone, sourceStatusTone } from "@/components/Badge";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { relativeTime } from "@/lib/format";
import { workerStatusSentence } from "@/lib/worker-status";
import { getWorkerStatus, listCompaniesWithNoSource, listRecentProblemScans, listRecentScanRuns, listSourcesNeedingAttention } from "@/lib/queries/health";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** The health of the companies this account follows. The whole catalogue and the queue are on Admin › Operations. */
export default async function HealthPage() {
  const user = await requireUser();
  const now = new Date();
  const [attentionSources, noSourceCompanies, problemScans, scanRuns, status] = await Promise.all([
    listSourcesNeedingAttention(user.id),
    listCompaniesWithNoSource(user.id),
    listRecentProblemScans(user.id, 7),
    listRecentScanRuns(10, user.id),
    getWorkerStatus(now),
  ]);
  // A heartbeat is rewritten on every boot, so "reported a minute ago" is true of a worker that
  // has crashed a hundred times today. When it has, say so instead.
  const trouble = workerStatusSentence(status);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Health"
        description="Sources and scans for the companies you follow."
        actions={user.role === "admin" ? <Link href="/admin/health" className="text-13 underline">Operations for the whole deployment</Link> : undefined}
      />

      <Card title="Background worker">
        <p className="text-14">
          {trouble ?? (status.heartbeat ? `Worker reported ${relativeTime(status.heartbeat.at, now)}.` : "No worker report.")}
        </p>
      </Card>

      <p className="text-14 text-muted">Attention lists show up to 100 items each. Use Companies to browse the full list.</p>
      <Card title={`Sources needing attention (${attentionSources.length + noSourceCompanies.length})`}>
        {attentionSources.length === 0 && noSourceCompanies.length === 0 ? (
          <EmptyState title="Nothing needs attention" description="Every source is active and every company has one." />
        ) : (
          <ul className="space-y-2 text-14">
            {attentionSources.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2">
                <Badge tone={sourceStatusTone(s.status)}>{s.status === "needs_confirmation" ? "needs confirmation" : s.status}</Badge>
                <Link href={`/companies/${s.companyId}`} className="font-medium text-fg hover:underline">{s.companyName}</Link>
                <span className="text-12 text-muted">{s.type}</span>
              </li>
            ))}
            {noSourceCompanies.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <Badge tone="red">no source</Badge>
                <Link href={`/companies/${c.id}`} className="font-medium text-fg hover:underline">{c.name}</Link>
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
                  <TD><Link href={`/companies/${p.companyId}`} className="hover:underline">{p.companyName}</Link></TD>
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
          <EmptyState title="No scan runs yet" description="Daily runs appear here once the schedule starts." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Started</TH>
                <TH>Trigger</TH>
                <TH>Your companies</TH>
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
