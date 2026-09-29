import Link from "next/link";
import { CompanyFavicon } from "@/components/CompanyFavicon";
import { companyIcon } from "@/lib/company-icon";
import { getCompanyWorkStatus } from "@/lib/work-status";
import { AutoRefresh } from "@/components/AutoRefresh";
import { AddedNotice } from "@/components/AddedNotice";
import { Badge, companyStatusTone, scanStatusTone, toneText } from "@/components/Badge";
import { buttonLinkClass } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { relativeTime, scanStatusLabel } from "@/lib/format";
import { Pagination, pageNumber } from "@/components/Pagination";
import { listCompanyPage } from "@/lib/queries/companies";
import { companySortParams, nextCompanySort, parseCompanySort, type CompanySort, type CompanySortKey } from "@/lib/company-sort";
import { GateSetup } from "@/components/GateSetup";
import { getSystemSettings } from "@/lib/settings";
import { hasChosenGate } from "@/lib/queries/setup";
import { needsEmailConfirmation, requireUser } from "@/lib/auth";
import { CompanyManageMenu } from "@/components/CompanyManageMenu";
import { nextScanSentence } from "./scan-line";
import { VERIFY_SENTENCE } from "@/components/VerifyNotice";
import { RefusalNotice } from "@/components/RefusalNotice";

export const dynamic = "force-dynamic";

/** A column head that sorts through the URL; the link turns the column round when it is the sorted one. */
function SortTH({ label, sortKey, order, title }: { label: string; sortKey: CompanySortKey; order: CompanySort; title?: string }) {
  const active = order.sort === sortKey;
  const params = new URLSearchParams(companySortParams(nextCompanySort(order, sortKey))).toString();
  return (
    <TH title={title} aria-sort={active ? (order.dir === "asc" ? "ascending" : "descending") : "none"}>
      <Link prefetch={false} href={`/companies${params ? `?${params}` : ""}`} className={`whitespace-nowrap no-underline hover:underline ${active ? "text-fg" : ""}`}>
        {label}
        {active && <span aria-hidden="true">{order.dir === "asc" ? " ▲" : " ▼"}</span>}
      </Link>
    </TH>
  );
}

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<{ added?: string; followed?: string; skipped?: string; page?: string; error?: string; sort?: string; dir?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const order = parseCompanySort(sp.sort, sp.dir);
  // The count, the page and the rest in one wave: a page past the end is re-read at the last one.
  const [{ rows, total, page }, work, system, gateChosen] = await Promise.all([listCompanyPage(user.id, pageNumber(sp.page), "", order), getCompanyWorkStatus(user.id), getSystemSettings(), hasChosenGate(user.id)]);
  const now = new Date();
  const unverified = needsEmailConfirmation(user);

  return (
    <div>
      {/* `#add` is where the setup checklist points: adding and following live on Discover. */}
      <PageHeader
        title="Companies"
        actions={<>
          <span className="text-12 text-muted" title="Every company is scanned once a day for all its followers">{nextScanSentence(system.scanTime, system.timezone)}</span>
          <Link id="add" prefetch={false} href="/suggestions" className={buttonLinkClass("secondary")}>Follow a company</Link>
        </>}
      />

      <RefusalNotice sentence={sp.error} className="mb-4" />

      <AddedNotice added={sp.added} followed={sp.followed} skipped={sp.skipped} className="mb-4" />

      {!gateChosen && (
        <div className="mb-6">
          {/* Nothing to prefill: an unchosen gate shows the example, never the default nobody picked. */}
          <GateSetup gate={null} chosen={false} title="Choose your filters first" />
        </div>
      )}

      <Pagination page={page} total={total} path="/companies" params={companySortParams(order)}/>
      {/* Silent: the status column is what changes, and it changes in place. */}
      {work.active && <AutoRefresh scope="company" initialVersion={work.version} message={null} />}
      {rows.length === 0 ? (
        <EmptyState
          title="No companies yet"
          description="Follow a company to see its matching roles here."
          action={<Link prefetch={false} href="/suggestions" className={buttonLinkClass("primary")}>Discover companies</Link>}
        />
      ) : (<>
        <div className="hidden md:block"><Table>
          <THead>
            <tr>
              <SortTH label="Company" sortKey="company" order={order} />
              <SortTH label="Source" sortKey="source" order={order} />
              <SortTH label="Status" sortKey="status" order={order} title="Sorts by the last scan" />
              <SortTH label="Open" sortKey="open" order={order} title="Roles your filters admitted that are still open" />
              <SortTH label="Review" sortKey="review" order={order} title="Matched roles you have not decided on" />
              <SortTH label="Shortlisted" sortKey="shortlisted" order={order} title="Roles here you chose to pursue" />
              <TH><span className="sr-only">Actions</span></TH>
            </tr>
          </THead>
          <TBody>
            {rows.map(({ company, subscription, lastScan, openRoles, reviewRoles, shortlistedRoles, sourceType, discovering, discoveryState, needsSource, lastDiscovery }) => (
              <TR key={company.id}>
                <TD>
                  <Link prefetch={false} href={`/companies/${company.id}`} className="flex items-center gap-2 no-underline hover:underline">
                    <CompanyFavicon {...companyIcon(company)} />
                    <span className="font-semibold text-fg">{company.name}</span>
                  </Link>
                  <a href={company.homepageUrl} target="_blank" rel="noopener noreferrer" className="block text-12 text-muted no-underline hover:underline">
                    {company.domain}
                  </a>
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
                        {lastDiscovery === "not_found" ? "Not found." : lastDiscovery === "needs_confirmation" ? "Needs confirming." : "Not discovered yet."}{" "}
                        <Link prefetch={false} href={`/companies/${company.id}#careers-url`} className="text-fg underline">Add careers URL</Link>
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
                    <Link prefetch={false} className="no-underline hover:underline" href={`/companies/${company.id}#roles`}>{openRoles}</Link>
                  ) : (
                    <span className="text-muted">0</span>
                  )}
                </TD>
                <TD>
                  {reviewRoles > 0 ? (
                    <Link prefetch={false} className="no-underline hover:underline" href={`/companies/${company.id}?view=auto-matched#roles`}>{reviewRoles}</Link>
                  ) : (
                    <span className="text-muted">0</span>
                  )}
                </TD>
                <TD>
                  {shortlistedRoles > 0 ? (
                    <Link prefetch={false} className="no-underline hover:underline" href={`/companies/${company.id}?view=user-shortlisted#roles`}>{shortlistedRoles}</Link>
                  ) : (
                    <span className="text-muted">0</span>
                  )}
                </TD>
                <TD>
                  {/* Refresh is occasional, so it sits in the row's Manage menu rather than beside it. */}
                  <CompanyManageMenu companyId={company.id} companyName={company.name} status={subscription.status}
                    extra="refresh" running={discoveryState === "running"} blockedReason={unverified ? VERIFY_SENTENCE : undefined} />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table></div>
        <div className="grid gap-3 md:hidden" aria-label="Tracked companies">
          {rows.map(({ company, subscription, lastScan, openRoles, reviewRoles, shortlistedRoles, sourceType, discovering, discoveryState, needsSource, lastDiscovery }) => (
            <article key={company.id} className="min-w-0 border-2 border-line p-4">
              <div className="flex min-w-0 items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <Link prefetch={false} href={`/companies/${company.id}`} className="flex min-h-11 items-center gap-2 font-semibold text-fg underline">
                    <CompanyFavicon {...companyIcon(company)} /><span className="min-w-0 truncate">{company.name}</span>
                  </Link>
                  <a href={company.homepageUrl} target="_blank" rel="noopener noreferrer" className="block min-h-11 truncate py-2 text-12 text-muted underline">{company.domain}</a>
                </div>
                <CompanyManageMenu companyId={company.id} companyName={company.name} status={subscription.status}
                  extra="refresh" running={discoveryState === "running"} blockedReason={unverified ? VERIFY_SENTENCE : undefined} />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-12">
                {needsSource && !discovering && subscription.status === "active" ? <Badge tone="amber">no careers source</Badge>
                  : <Badge tone={companyStatusTone(subscription.status)}>{subscription.status}</Badge>}
                {sourceType && <Badge tone="neutral">{sourceType}</Badge>}
                {discovering && <span className="text-info">{discoveryState === "running" ? "Discovering…" : "Discovery queued"}</span>}
              </div>
              {needsSource && !discovering && subscription.status === "active" && <p className="mt-2 text-13 text-muted">
                {lastDiscovery === "not_found" ? "Careers source not found." : lastDiscovery === "needs_confirmation" ? "Careers source needs confirming." : "No careers source yet."}{" "}
                <Link prefetch={false} href={`/companies/${company.id}#careers-url`} className="text-fg underline">Add careers URL</Link>
              </p>}
              <p className="mt-2 text-12 text-muted">{lastScan ? `${scanStatusLabel(lastScan.status)} ${relativeTime(lastScan.startedAt, now)}` : needsSource ? "Waiting for a source" : "Never scanned"}</p>
              <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line-faint pt-3 text-center text-12">
                <Link prefetch={false} href={`/companies/${company.id}#roles`} className="min-h-11 underline"><strong className="block text-16">{openRoles}</strong>Open</Link>
                <Link prefetch={false} href={`/companies/${company.id}?view=auto-matched#roles`} className="min-h-11 underline"><strong className="block text-16">{reviewRoles}</strong>Review</Link>
                <Link prefetch={false} href={`/companies/${company.id}?view=user-shortlisted#roles`} className="min-h-11 underline"><strong className="block text-16">{shortlistedRoles}</strong>Shortlisted</Link>
              </div>
            </article>
          ))}
        </div>
      </>
      )}
    </div>
  );
}
