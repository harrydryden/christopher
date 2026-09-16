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
import { inputClass, labelClass } from "@/components/Field";
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
      <PageHeader title="Companies" />

      {sp.added !== undefined && (
        <div className="mb-4 border-2 border-ok px-3 py-2 text-14 text-ok">
          Added {sp.added} {sp.added === "1" ? "company" : "companies"}.
          {sp.skipped && <span className="block">Skipped (already tracked or invalid): {sp.skipped}</span>}
        </div>
      )}

      <Card title="Add companies" className="mb-6">
        <form action={addCompanies} className="flex flex-col gap-2">
          <label htmlFor="urls" className="text-14 text-muted">
            One homepage URL per line, or comma-separated. Each is discovered independently.
          </label>
          <textarea
            id="urls"
            name="urls"
            rows={3}
            required
            placeholder={"acme.com\nhttps://example.org"}
            className={`resize-y ${inputClass}`}
          />
          <div>
            <Button type="submit" variant="primary">
              Add companies
            </Button>
          </div>
        </form>
      </Card>

      <form method="get" className="mb-4 flex flex-wrap items-end gap-3"><label className="grid gap-1.5"><span className={labelClass}>Search companies</span><input name="q" defaultValue={q} maxLength={200} className={`h-11 w-80 ${inputClass}`} /></label><Button type="submit" className="h-11">Search</Button>{q && <a className="self-center text-13 underline" href="/companies">Clear</a>}</form>
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
                  <a href={`/companies/${company.id}`} className="flex items-center gap-2 no-underline hover:underline">
                    {company.faviconUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={company.faviconUrl} alt="" width={16} height={16} referrerPolicy="no-referrer" className="shrink-0" />
                    ) : (
                      <span className="inline-block h-4 w-4 shrink-0 bg-track" />
                    )}
                    <span className="font-semibold text-fg">{company.name}</span>
                  </a>
                  <a href={company.homepageUrl} target="_blank" rel="noopener noreferrer" className="block text-12 text-muted no-underline hover:underline">
                    {company.domain}
                  </a>
                </TD>
                <TD>
                  <Badge tone={companyStatusTone(company.status)}>{company.status}</Badge>
                  {discovering && <p className="mt-1 text-12 text-info">{discoveryState === "running" ? "Refreshing…" : "Refresh queued"}</p>}
                </TD>
                <TD className="whitespace-nowrap">
                  {lastScan ? (
                    <span className="flex items-center gap-1.5" title={lastScan.startedAt.toISOString()}>
                      <Badge tone={scanStatusTone(lastScan.status)}>{lastScan.status}</Badge>
                      {relativeTime(lastScan.startedAt, now)}
                    </span>
                  ) : (
                    <span className="text-muted">never</span>
                  )}
                </TD>
                <TD>
                  {reviewRoles || shortlistedRoles ? <div className="flex flex-wrap gap-x-2">
                    <a className="no-underline hover:underline" href={`/companies/${company.id}?view=auto-matched#roles`}>{reviewRoles} to review</a>
                    <span>·</span>
                    <a className="no-underline hover:underline" href={`/companies/${company.id}?view=user-shortlisted#roles`}>{shortlistedRoles} shortlisted</a>
                  </div> : <span className="text-muted">No roles to review</span>}
                </TD>
                <TD>
                  <div className="flex flex-wrap gap-2">
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
                        <ConfirmSubmitButton variant="ghost" confirmMessage={`Archive ${company.name}? It will stop being scanned but its data is kept.`}>Archive</ConfirmSubmitButton>
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
