import Link from "next/link";
import { Badge, scanStatusTone } from "@/components/Badge";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { HealthItems } from "@/components/HealthItems";
import { PageHeader } from "@/components/PageHeader";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { relativeTime } from "@/lib/format";
import { workerStatusSentence } from "@/lib/worker-status";
import { countHealthItems, getWorkerStatus, healthItems, listRecentProblemScans, listRecentScanRuns } from "@/lib/queries/health";
import { needsEmailConfirmation, requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** The health of the companies this account follows. The whole catalogue and the queue are on Admin › Operations. */
export default async function HealthPage() {
  const user = await requireUser();
  const now = new Date();
  const [items, itemCount, problemScans, scanRuns, status] = await Promise.all([
    healthItems(user.id, now),
    countHealthItems(user.id, now),
    listRecentProblemScans(user.id, 7),
    listRecentScanRuns(10, user.id),
    getWorkerStatus(now),
  ]);
  // A heartbeat is rewritten on every boot, so "reported a minute ago" is true of a worker that
  // has crashed a hundred times today. When it has, say so instead.
  const trouble = workerStatusSentence(status);
  // Confirming a candidate, pasting a URL and re-discovering all spend the deployment's money, so
  // they wait for a confirmed address. Saying so here beats saying it after the click.
  const unverified = needsEmailConfirmation(user);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Health"
        description="Everything that needs you, and how the companies you follow are being read."
        actions={user.role === "admin" ? <Link href="/admin/health" className="text-13 underline">Operations for the whole deployment</Link> : undefined}
      />

      <Card title={`Needs you (${itemCount})`}>
        {items.length === 0 ? (
          <EmptyState title="Nothing needs you" description="Every company you follow has a careers page that is being read, and your AI budget has room in it." />
        ) : (
          <div className="space-y-3">
            <HealthItems items={items} unverified={unverified} />
            {itemCount > items.length && (
              <p className="text-12 text-muted">
                Showing the first {items.length} of {itemCount}. Resolve some, or browse the rest from{" "}
                <Link href="/companies" className="text-fg underline">Companies</Link>.
              </p>
            )}
          </div>
        )}
      </Card>

      <Card title="Background worker">
        <p className="text-14">
          {trouble ?? (status.heartbeat ? `Worker reported ${relativeTime(status.heartbeat.at, now)}.` : "No worker report.")}
        </p>
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
