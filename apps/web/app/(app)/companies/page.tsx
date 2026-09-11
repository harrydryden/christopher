import { RefreshCompanyButton } from "@/components/RefreshCompanyButton";
import { getCompanyWorkStatus } from "@/lib/work-status";
import { AutoRefresh } from "@/components/AutoRefresh";
import { addCompanies, archiveCompany, pauseCompany, resumeCompany } from "@/app/actions/companies";
import { Badge, companyStatusTone, scanStatusTone } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { relativeTime } from "@/lib/format";
import { Pagination, pageNumber } from "@/components/Pagination";
import { listCompanies, companyCount } from "@/lib/queries/companies";

export const dynamic = "force-dynamic";

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<{ added?: string; skipped?: string; page?: string; q?: string }> }) {
  const sp = await searchParams;
  const q = (sp.q ?? "").slice(0, 200);
  const total = await companyCount(q);
  const page = Math.min(pageNumber(sp.page), Math.max(1, Math.ceil(total / 50)));
  const [rows, work] = await Promise.all([listCompanies(page, q), getCompanyWorkStatus()]);
  const now = new Date();

  return (
    <div>
      <PageHeader title="Companies" description="Track companies and refresh their roles. Refresh checks existing careers pages and finds one when needed." />

      {sp.added !== undefined && (
        <div className="mb-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Added {sp.added} {sp.added === "1" ? "company" : "companies"}.
          {sp.skipped && <span className="block text-emerald-700/80">Skipped (already tracked or invalid): {sp.skipped}</span>}
        </div>
      )}

      <Card title="Add companies" className="mb-6">
        <form action={addCompanies} className="flex flex-col gap-2">
          <label htmlFor="urls" className="text-sm text-slate-500">
            One homepage URL per line, or comma-separated. Each is discovered independently.
          </label>
          <textarea
            id="urls"
            name="urls"
            rows={3}
            required
            placeholder={"acme.com\nhttps://example.org"}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
          <div>
            <Button type="submit" variant="primary">
              Add companies
            </Button>
          </div>
        </form>
      </Card>

      <form method="get" className="mb-4 flex flex-wrap gap-2"><label className="flex min-w-0 flex-wrap items-center gap-2 text-sm">Search companies<input name="q" defaultValue={q} maxLength={200} className="min-h-11 rounded border bg-transparent px-3" /></label><Button type="submit">Search</Button>{q && <a className="self-center underline" href="/companies">Clear</a>}</form>
      <Pagination page={page} total={total} path="/companies" params={{ q }}/>
      {work.active && <div className="mb-4"><AutoRefresh message="Company scanning or discovery is pending. Status updates automatically." /></div>}
      {rows.length === 0 ? (
        <EmptyState title={q ? "No matching companies" : "No companies yet"} description={q ? "Try another name or domain." : "Add a homepage URL above to start tracking a company’s careers page."} />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Company</TH>
              <TH>Status</TH>
              <TH>Last scan</TH>
              <TH>Roles</TH>
              <TH>Actions</TH>
            </tr>
          </THead>
          <TBody>
            {rows.map(({ company, lastScan, reviewRoles, shortlistedRoles, discovering, discoveryState }) => (
              <TR key={company.id}>
                <TD>
                  <a href={`/companies/${company.id}`} className="flex items-center gap-2 hover:underline">
                    {company.faviconUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={company.faviconUrl} alt="" width={16} height={16} referrerPolicy="no-referrer" className="rounded-sm" />
                    ) : (
                      <span className="inline-block h-4 w-4 rounded-sm bg-slate-200" />
                    )}
                    <span className="font-medium text-slate-900">{company.name}</span>
                  </a>
                  <a href={company.homepageUrl} target="_blank" rel="noopener noreferrer" className="block text-xs text-slate-500 hover:underline">
                    {company.domain}
                  </a>
                </TD>
                <TD>
                  <Badge tone={companyStatusTone(company.status)}>{company.status}</Badge>
                  {discovering && <p className="mt-1 text-xs text-accent">{discoveryState === "running" ? "Refreshing…" : "Refresh queued"}</p>}
                </TD>
                <TD className="whitespace-nowrap">
                  {lastScan ? (
                    <span className="flex items-center gap-1.5" title={lastScan.startedAt.toISOString()}>
                      <Badge tone={scanStatusTone(lastScan.status)}>{lastScan.status}</Badge>
                      {relativeTime(lastScan.startedAt, now)}
                    </span>
                  ) : (
                    <span className="text-slate-500">never</span>
                  )}
                </TD>
                <TD>
                  {reviewRoles || shortlistedRoles ? <div className="flex flex-wrap gap-x-2">
                    <a className="hover:underline" href={`/companies/${company.id}?view=auto-matched#roles`}>{reviewRoles} to review</a>
                    <span>·</span>
                    <a className="hover:underline" href={`/companies/${company.id}?view=user-shortlisted#roles`}>{shortlistedRoles} shortlisted</a>
                  </div> : <span className="text-slate-500">No roles to review</span>}
                </TD>
                <TD>
                  <div className="flex flex-wrap gap-1.5">
                    {company.status === "active" && <RefreshCompanyButton companyId={company.id} running={discoveryState === "running"} />}
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
