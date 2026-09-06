import { AutoRefresh } from "@/components/AutoRefresh";
import Link from "next/link";
import { addCompanies, archiveCompany, pauseCompany, rediscoverCompany, rescanCompany, resumeCompany } from "@/app/actions/companies";
import { Badge, companyStatusTone, scanStatusTone, sourceStatusTone } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { relativeTime } from "@/lib/format";
import { listCompanies } from "@/lib/queries/companies";

export const dynamic = "force-dynamic";

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<{ added?: string; skipped?: string }> }) {
  const sp = await searchParams;
  const rows = await listCompanies();
  const now = new Date();

  return (
    <div>
      <PageHeader title="Companies" description="Every company you track, and where its careers page comes from." />

      {sp.added !== undefined && (
        <div className="mb-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          Added {sp.added} {sp.added === "1" ? "company" : "companies"}.
          {sp.skipped && <span className="block text-emerald-700/80 dark:text-emerald-400/80">Skipped (already tracked or invalid): {sp.skipped}</span>}
        </div>
      )}

      <Card title="Add companies" className="mb-6">
        <form action={addCompanies} className="flex flex-col gap-2">
          <label htmlFor="urls" className="text-sm text-slate-500 dark:text-slate-400">
            One homepage URL per line, or comma-separated. Each is discovered independently.
          </label>
          <textarea
            id="urls"
            name="urls"
            rows={3}
            required
            placeholder={"acme.com\nhttps://example.org"}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-950"
          />
          <div>
            <Button type="submit" variant="primary">
              Add companies
            </Button>
          </div>
        </form>
      </Card>

      {rows.some(row => row.discovering) && <div className="mb-4"><AutoRefresh message="Discovery work is pending. This page refreshes automatically; check Health if it remains queued." /></div>}
      {rows.length === 0 ? (
        <EmptyState title="No companies yet" description="Add a homepage URL above to start tracking a company's careers page." />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Company</TH>
              <TH>Status</TH>
              <TH>Sources</TH>
              <TH>Last scan</TH>
              <TH>Roles</TH>
              <TH>Actions</TH>
            </tr>
          </THead>
          <TBody>
            {rows.map(({ company, sources, lastScan, openRoles, inTableRoles, discovering, discoveryState }) => (
              <TR key={company.id}>
                <TD>
                  <Link href={`/companies/${company.id}`} className="flex items-center gap-2 hover:underline">
                    {company.faviconUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={company.faviconUrl} alt="" width={16} height={16} referrerPolicy="no-referrer" className="rounded-sm" />
                    ) : (
                      <span className="inline-block h-4 w-4 rounded-sm bg-slate-200 dark:bg-slate-700" />
                    )}
                    <span className="font-medium text-slate-900 dark:text-slate-100">{company.name}</span>
                  </Link>
                  <a href={company.homepageUrl} target="_blank" rel="noopener noreferrer" className="block text-xs text-slate-400 hover:underline">
                    {company.domain}
                  </a>
                </TD>
                <TD>
                  <Badge tone={companyStatusTone(company.status)}>{company.status}</Badge>
                </TD>
                <TD>
                  {sources.length === 0 ? (
                    <Badge tone="red">none</Badge>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {sources.map((s) => (
                        <div key={s.id} className="flex items-center gap-1.5 text-xs">
                          <Badge tone="neutral">{s.type}</Badge>
                          <span className="text-slate-400">{Math.round(s.confidence * 100)}%</span>
                          <Badge tone={sourceStatusTone(s.status)}>{s.status === "needs_confirmation" ? "needs confirmation" : s.status}</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                  {discovering && <p className="mt-1 text-xs text-indigo-500">{discoveryState === "running" ? "Discovering…" : "Queued — waiting for worker"}</p>}
                </TD>
                <TD className="whitespace-nowrap">
                  {lastScan ? (
                    <span className="flex items-center gap-1.5" title={lastScan.startedAt.toISOString()}>
                      <Badge tone={scanStatusTone(lastScan.status)}>{lastScan.status}</Badge>
                      {relativeTime(lastScan.startedAt, now)}
                    </span>
                  ) : (
                    <span className="text-slate-400">never</span>
                  )}
                </TD>
                <TD>
                  {openRoles} open · {inTableRoles} in table
                </TD>
                <TD>
                  <div className="flex flex-wrap gap-1.5">
                    <form action={rescanCompany.bind(null, company.id)}>
                      <Button type="submit" size="sm">
                        Rescan
                      </Button>
                    </form>
                    <form action={rediscoverCompany.bind(null, company.id)}>
                      <Button type="submit" size="sm">
                        Re-discover
                      </Button>
                    </form>
                    {company.status === "active" ? (
                      <form action={pauseCompany.bind(null, company.id)}>
                        <Button type="submit" size="sm">
                          Pause
                        </Button>
                      </form>
                    ) : company.status === "paused" ? (
                      <form action={resumeCompany.bind(null, company.id)}>
                        <Button type="submit" size="sm">
                          Resume
                        </Button>
                      </form>
                    ) : null}
                    {company.status !== "archived" && (
                      <form action={archiveCompany.bind(null, company.id)}>
                        <ConfirmSubmitButton confirmMessage={`Archive ${company.name}? It will stop being scanned but its data is kept.`}>Archive</ConfirmSubmitButton>
                      </form>
                    )}
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
