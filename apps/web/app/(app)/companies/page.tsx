import { RefreshCompanyButton } from "@/components/RefreshCompanyButton";
import { CompanyFavicon } from "@/components/CompanyFavicon";
import { companyIcon } from "@/lib/company-icon";
import { getCompanyWorkStatus } from "@/lib/work-status";
import { AutoRefresh } from "@/components/AutoRefresh";
import { addCompanies } from "@/app/actions/companies";
import { Badge, companyStatusTone, scanStatusTone, toneText } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { inputClass, labelClass } from "@/components/Field";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { relativeTime, scanStatusLabel } from "@/lib/format";
import { Pagination, pageNumber } from "@/components/Pagination";
import { listCompanies, companyCount } from "@/lib/queries/companies";
import { SearchForm, SearchPending } from "@/components/SearchForm";
import { GateSetup } from "@/components/GateSetup";
import { getSystemSettings } from "@/lib/settings";
import { hasChosenGate } from "@/lib/queries/setup";
import { CHOOSE_GATE_SENTENCE } from "@/lib/setup";
import { needsEmailConfirmation, requireUser } from "@/lib/auth";
import { CompanyControls } from "./CompanyControls";
import { nextScanSentence } from "./scan-line";
import { VERIFY_SENTENCE, VerifyNotice } from "@/components/VerifyNotice";

export const dynamic = "force-dynamic";

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<{ added?: string; followed?: string; skipped?: string; page?: string; q?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const q = (sp.q ?? "").slice(0, 200);
  const total = await companyCount(user.id, q);
  const page = Math.min(pageNumber(sp.page), Math.max(1, Math.ceil(total / 50)));
  const [rows, work, system, gateChosen] = await Promise.all([listCompanies(user.id, page, q), getCompanyWorkStatus(user.id), getSystemSettings(), hasChosenGate(user.id)]);
  const now = new Date();
  // The wall is on the form, not on the action: `addCompanies` still asks for itself.
  const unverified = needsEmailConfirmation(user);
  // Filters first: following a company starts scanning it, so the gate is chosen before the form
  // will send. `addCompanies` refuses on the same rule.
  const blocked = unverified || !gateChosen;

  return (
    <div>
      <PageHeader
        title="Companies"
        description={`Companies are shared across every account and scanned once a day — ${nextScanSentence(system.scanTime, system.timezone)}. Following one gives you its roles through your own filters.`}
      />

      {sp.added !== undefined && (
        <div className="mb-4 border-2 border-ok px-3 py-2 text-14 text-ok">
          Added {sp.added} new {sp.added === "1" ? "company" : "companies"}.
          {sp.followed && <span className="block">Followed {sp.followed} already-tracked {sp.followed === "1" ? "company" : "companies"}; their matching roles are in your table now.</span>}
          {sp.skipped && <span className="block">Skipped (already yours or invalid): {sp.skipped}</span>}
        </div>
      )}

      {!gateChosen && (
        <div className="mb-6">
          {/* Nothing to prefill: an unchosen gate shows the example, never the default nobody picked. */}
          <GateSetup gate={null} chosen={false} title="Choose your filters first" />
        </div>
      )}

      <div id="add">
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
            disabled={blocked}
            placeholder={"acme.com\nhttps://example.org"}
            className={`resize-y ${inputClass}`}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabled={blocked}>
              Add companies
            </Button>
            {unverified && <VerifyNotice />}
            {!unverified && !gateChosen && <p className="text-12 text-warn" role="status">{CHOOSE_GATE_SENTENCE}</p>}
          </div>
        </form>
      </Card>
      </div>

      <SearchForm action="/companies" className="mb-4 flex flex-wrap items-end gap-3"><label className="grid gap-1.5"><span className={labelClass}>Search companies</span><input name="q" defaultValue={q} maxLength={200} className={`h-11 w-80 ${inputClass}`} /></label><Button type="submit" className="h-11">Search</Button><SearchPending />{q && <a className="self-center text-13 underline" href="/companies">Clear</a>}</SearchForm>
      <Pagination page={page} total={total} path="/companies" params={{ q }}/>
      {work.active && <div className="mb-4"><AutoRefresh scope="company" initialVersion={work.version} message="Company scanning or discovery is pending. Status updates automatically." /></div>}
      {rows.length === 0 ? (
        <EmptyState title={q ? "No matching companies" : "No companies yet"} description={q ? "Try another name or domain." : "Add a homepage URL above to start following a company’s careers page."} />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Company</TH>
              <TH>Source</TH>
              <TH>Status</TH>
              <TH title="Roles your filters admitted that are still open">Open</TH>
              <TH title="Matched roles you have not decided on">Review</TH>
              <TH title="Roles here you chose to pursue">Shortlisted</TH>
              <TH>Actions</TH>
            </tr>
          </THead>
          <TBody>
            {rows.map(({ company, subscription, lastScan, openRoles, reviewRoles, shortlistedRoles, sourceType, followers, discovering, discoveryState, needsSource, lastDiscovery }) => (
              <TR key={company.id}>
                <TD>
                  <a href={`/companies/${company.id}`} className="flex items-center gap-2 no-underline hover:underline">
                    <CompanyFavicon {...companyIcon(company)} />
                    <span className="font-semibold text-fg">{company.name}</span>
                  </a>
                  <a href={company.homepageUrl} target="_blank" rel="noopener noreferrer" className="block text-12 text-muted no-underline hover:underline">
                    {company.domain}
                  </a>
                  {followers > 1 && <span className="block text-12 text-faint">Followed by {followers} accounts</span>}
                </TD>
                <TD>
                  {/* What a scan reads: a feed is worth knowing about, because an HTML fallback is
                      the shakiest of them. */}
                  {sourceType ? <Badge tone="neutral">{sourceType}</Badge> : <span className="text-12 text-muted">none</span>}
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
                  {openRoles > 0 ? (
                    <a className="no-underline hover:underline" href={`/companies/${company.id}#roles`}>{openRoles}</a>
                  ) : (
                    <span className="text-muted">0</span>
                  )}
                </TD>
                <TD>
                  {reviewRoles > 0 ? (
                    <a className="no-underline hover:underline" href={`/companies/${company.id}?view=auto-matched#roles`}>{reviewRoles}</a>
                  ) : (
                    <span className="text-muted">0</span>
                  )}
                </TD>
                <TD>
                  {shortlistedRoles > 0 ? (
                    <a className="no-underline hover:underline" href={`/companies/${company.id}?view=user-shortlisted#roles`}>{shortlistedRoles}</a>
                  ) : (
                    <span className="text-muted">0</span>
                  )}
                </TD>
                <TD>
                  <div className="flex flex-wrap items-start gap-2">
                    {subscription.status === "active" && (
                      <RefreshCompanyButton
                        companyId={company.id}
                        running={discoveryState === "running"}
                        blockedReason={unverified ? VERIFY_SENTENCE : undefined}
                      />
                    )}
                    <CompanyControls companyId={company.id} companyName={company.name} status={subscription.status} />
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
