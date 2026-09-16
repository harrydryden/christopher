import { RefreshCompanyButton } from "@/components/RefreshCompanyButton";
import { CompanyFavicon } from "@/components/CompanyFavicon";
import { getCompanyWorkStatus } from "@/lib/work-status";
import { AutoRefresh } from "@/components/AutoRefresh";
import { addCompanies, archiveCompany, pauseCompany, resumeCompany } from "@/app/actions/companies";
import { Badge, companyStatusTone, scanStatusTone, toneText } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { inputClass, labelClass } from "@/components/Field";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { relativeTime, scanStatusLabel } from "@/lib/format";
import { Pagination, pageNumber } from "@/components/Pagination";
import { listCompanies, companyCount } from "@/lib/queries/companies";
import { SearchForm, SearchPending } from "@/components/SearchForm";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<{ added?: string; followed?: string; skipped?: string; page?: string; q?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const q = (sp.q ?? "").slice(0, 200);
  const total = await companyCount(user.id, q);
  const page = Math.min(pageNumber(sp.page), Math.max(1, Math.ceil(total / 50)));
  const [rows, work] = await Promise.all([listCompanies(user.id, page, q), getCompanyWorkStatus(user.id)]);
  const now = new Date();

  return (
    <div>
      <PageHeader title="Companies" description="Companies are shared across every account and scanned once a day. Following one gives you its roles through your own filters." />

      {sp.added !== undefined && (
        <div className="mb-4 border-2 border-ok px-3 py-2 text-14 text-ok">
          Added {sp.added} new {sp.added === "1" ? "company" : "companies"}.
          {sp.followed && <span className="block">Followed {sp.followed} already-tracked {sp.followed === "1" ? "company" : "companies"}; their matching roles are in your table now.</span>}
          {sp.skipped && <span className="block">Skipped (already yours or invalid): {sp.skipped}</span>}
        </div>
      )}

      <Card title="Add companies" className="mb-6">
        <form action={addCompanies} className="flex flex-col gap-2">
          <label htmlFor="urls" className="text-14 text-muted">
            One homepage URL per line, or comma-separated. A company nobody tracks yet is discovered once; one already in the catalogue is simply followed.
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

      <SearchForm action="/companies" className="mb-4 flex flex-wrap items-end gap-3"><label className="grid gap-1.5"><span className={labelClass}>Search companies</span><input name="q" defaultValue={q} maxLength={200} className={`h-11 w-80 ${inputClass}`} /></label><Button type="submit" className="h-11">Search</Button><SearchPending />{q && <a className="self-center text-13 underline" href="/companies">Clear</a>}</SearchForm>
      <Pagination page={page} total={total} path="/companies" params={{ q }}/>
      {work.active && <div className="mb-4"><AutoRefresh message="Company scanning or discovery is pending. Status updates automatically." /></div>}
      {rows.length === 0 ? (
        <EmptyState title={q ? "No matching companies" : "No companies yet"} description={q ? "Try another name or domain." : "Add a homepage URL above to start following a company’s careers page."} />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Company</TH>
              <TH>Status</TH>
              <TH>Review</TH>
              <TH>Actions</TH>
            </tr>
          </THead>
          <TBody>
            {rows.map(({ company, subscription, lastScan, reviewRoles, followers, discovering, discoveryState, needsSource, lastDiscovery }) => (
              <TR key={company.id}>
                <TD>
                  <a href={`/companies/${company.id}`} className="flex items-center gap-2 no-underline hover:underline">
                    <CompanyFavicon src={company.faviconUrl} domain={company.domain} />
                    <span className="font-semibold text-fg">{company.name}</span>
                  </a>
                  <a href={company.homepageUrl} target="_blank" rel="noopener noreferrer" className="block text-12 text-muted no-underline hover:underline">
                    {company.domain}
                  </a>
                  {followers > 1 && <span className="block text-12 text-faint">Followed by {followers} accounts</span>}
                </TD>
                <TD>
                  {/* Status leads; the last scan is the sub-line under it, so the health of
                      the scan is read as a footnote to the company's state, not as a rival. */}
                  {needsSource && !discovering && subscription.status === "active" ? (
                    <>
                      <Badge tone="amber">no careers source</Badge>
                      <p className="mt-1 text-12 text-muted">
                        {lastDiscovery === "not_found" ? "Could not find the careers page." : lastDiscovery === "needs_confirmation" ? "Needs a source confirmed." : "Not discovered yet."}{" "}
                        <a href={`/companies/${company.id}#careers-url`} className="text-fg underline">Add careers URL</a>
                      </p>
                    </>
                  ) : (
                    <>
                      <Badge tone={companyStatusTone(subscription.status)}>{subscription.status}</Badge>
                      {lastScan ? (
                        <p
                          className={`mt-1 text-12 whitespace-nowrap ${lastScan.status === "ok" ? "text-muted" : toneText(scanStatusTone(lastScan.status))}`}
                          title={lastScan.startedAt.toISOString()}
                        >
                          {scanStatusLabel(lastScan.status)} {relativeTime(lastScan.startedAt, now)}
                        </p>
                      ) : (
                        <p className="mt-1 text-12 whitespace-nowrap text-muted">{needsSource ? "Waiting for a source" : "Never scanned"}</p>
                      )}
                    </>
                  )}
                  {discovering && <p className="mt-1 text-12 text-info">{discoveryState === "running" ? "Discovering…" : "Discovery queued"}</p>}
                </TD>
                <TD>
                  {reviewRoles > 0 ? (
                    <a className="no-underline hover:underline" href={`/companies/${company.id}?view=auto-matched#roles`}>{reviewRoles}</a>
                  ) : (
                    <span className="text-muted">0</span>
                  )}
                </TD>
                <TD>
                  <div className="flex flex-wrap gap-2">
                    {subscription.status === "active" && <RefreshCompanyButton companyId={company.id} running={discoveryState === "running"} />}
                    {subscription.status === "active" ? (
                      <form action={pauseCompany.bind(null, company.id)}>
                        <Button type="submit" size="sm">
                          Pause
                        </Button>
                      </form>
                    ) : subscription.status === "paused" ? (
                      <form action={resumeCompany.bind(null, company.id)}>
                        <Button type="submit" size="sm">
                          Resume
                        </Button>
                      </form>
                    ) : null}
                    {subscription.status !== "archived" && (
                      <form action={archiveCompany.bind(null, company.id)}>
                        <ConfirmSubmitButton variant="ghost" confirmMessage={`Archive ${company.name}? It leaves your inbox; other followers are unaffected.`}>Archive</ConfirmSubmitButton>
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
