import Link from "next/link";
import { Badge, scanStatusTone } from "@/components/Badge";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { relativeTime } from "@/lib/format";
import type { listRecentScanRuns, ProblemScanRow } from "@/lib/queries/health";

/**
 * The two scan cards Health and Operations both show: the problem scans of the last week and the
 * recent runs. Health reads them for the companies one account follows and links a company to its
 * page; Operations reads the whole catalogue and links into the catalogue.
 */
export function ProblemScansCard({ title, rows, now, companyHref }: { title: string; rows: ProblemScanRow[]; now: Date; companyHref: (row: ProblemScanRow) => string }) {
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <EmptyState title="No problem scans" description="No problem scans are recorded in the last 7 days." />
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
            {rows.map((p) => (
              <TR key={p.scan.id}>
                <TD><Link prefetch={false} href={companyHref(p)} className="hover:underline">{p.companyName}</Link></TD>
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
  );
}

export function ScanRunsCard({ runs, now, companiesLabel, emptyDescription }: { runs: Awaited<ReturnType<typeof listRecentScanRuns>>; now: Date; companiesLabel: string; emptyDescription: string }) {
  return (
    <Card title="Recent daily scan runs">
      <p className="mb-3 text-14 text-muted">Scheduled and manually started daily runs appear here. Scans from adding or refreshing a company are recorded separately in its scan history.</p>
      {runs.length === 0 ? (
        <EmptyState title="No daily scan runs yet" description={emptyDescription} />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Started</TH>
              <TH>Trigger</TH>
              <TH>{companiesLabel}</TH>
              <TH>New postings / Closed</TH>
            </tr>
          </THead>
          <TBody>
            {runs.map((r) => (
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
  );
}
