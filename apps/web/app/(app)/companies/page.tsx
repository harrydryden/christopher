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
import { getWorkerStatus } from "@/lib/queries/health";
import { nextScanSentence } from "./scan-line";
import { VERIFY_SENTENCE } from "@/components/VerifyNotice";
import { RefusalNotice } from "@/components/RefusalNotice";
import { CompanyCapacityReadout } from "@/components/CompanyCapacityReadout";
import { getCompanyEntitlement } from "@/lib/billing/service";

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

function activityLabel(type: "discover" | "scan_company" | null, state: "queued" | "running" | null, workerState: "healthy" | "stopped" | "restarting" | null): string | null {
  if (!type || !state) return null;
  if (state === "running" && workerState === "stopped") return type === "discover" ? "Discovery waiting for monitoring" : "Scan waiting for monitoring";
  if (state === "running" && workerState === "restarting") return type === "discover" ? "Discovery may be interrupted" : "Scan may be interrupted";
  return type === "discover" ? (state === "running" ? "Discovering…" : "Discovery queued")
    : state === "running" ? "Scanning…" : "Scan queued";
}

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<{ added?: string; followed?: string; skipped?: string; page?: string; error?: string; sort?: string; dir?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const order = parseCompanySort(sp.sort, sp.dir);
  // The count, the page and the rest in one wave: a page past the end is re-read at the last one.
  const [{ rows, total, page }, work, system, gateChosen, companyEntitlement] = await Promise.all([listCompanyPage(user.id, pageNumber(sp.page), "", order), getCompanyWorkStatus(user.id), getSystemSettings(), hasChosenGate(user.id), getCompanyEntitlement(user.id)]);
  const workerState = rows.some(row => row.activityState === "running") ? (await getWorkerStatus()).state : null;
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

      <CompanyCapacityReadout {...companyEntitlement} />

      <RefusalNotice sentence={sp.error} className="mb-4" />

      <AddedNotice added={sp.added} followed={sp.followed} skipped={sp.skipped} className="mb-4" />

      {!gateChosen && (
        <div className="mb-6">
          {/* Nothing to prefill: an unchosen gate shows the example, never the default nobody picked. */}
          <GateSetup gate={null} chosen={false} title="Choose your filters first" />
        </div>
      )}

      {total > 50 && <Pagination page={page} total={total} path="/companies" params={companySortParams(order)}/>}
      {/* Silent: the status column is what changes, and it changes in place. */}
      {work.active && <AutoRefresh scope="company" initialVersion={work.version} message={null} />}
      {rows.length === 0 ? (
        <EmptyState
          title="No companies yet"
          description="Follow a company to see its matching roles here."
          action={<Link prefetch={false} href="/suggestions" className={buttonLinkClass("primary")}>Discover companies</Link>}
        />
      ) : (<>
        <details className="mb-3 text-13 text-muted">
          <summary className="inline-flex min-h-11 cursor-pointer items-center underline">More ways to sort</summary>
          <div className="flex flex-wrap gap-3 pb-2">
            {([ ["source", "Source"], ["open", "Open roles"], ["shortlisted", "Shortlisted"] ] as const).map(([key, label]) =>
              <Link key={key} prefetch={false} href={`/companies?${new URLSearchParams(companySortParams(nextCompanySort(order, key)))}`} className="inline-flex min-h-11 items-center underline">{label}</Link>)}
          </div>
        </details>
        <div className="hidden md:block"><Table>
          <THead>
            <tr>
              <SortTH label="Company" sortKey="company" order={order} />
              <SortTH label="Roles to review" sortKey="review" order={order} title="Matched roles you have not decided on" />
              <SortTH label="Monitoring" sortKey="status" order={order} title="Sorts by the last scan" />
              <TH>Manage</TH>
            </tr>
          </THead>
          <TBody>
            {rows.map(({ company, subscription, lastScan, openRoles, reviewRoles, shortlistedRoles, sourceType, discovering, activityState, activityType, needsSource, lastDiscovery }) => (
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
                  {reviewRoles > 0 ? <Link prefetch={false} className="font-semibold no-underline hover:underline" href={`/companies/${company.id}?view=auto-matched#roles`}>{reviewRoles} to review</Link> : <span className="text-muted">None awaiting review</span>}
                  <div className="mt-1 flex flex-wrap gap-x-3 text-12 text-muted">
                    <Link prefetch={false} href={`/companies/${company.id}#roles`} className="underline">{openRoles} open</Link>
                    <Link prefetch={false} href={`/companies/${company.id}?view=user-shortlisted#roles`} className="underline">{shortlistedRoles} shortlisted</Link>
                  </div>
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
                      <Badge tone={subscription.status === "active" && lastScan && lastScan.status !== "ok" ? "amber" : companyStatusTone(subscription.status)}>
                        {subscription.status === "active" && lastScan && lastScan.status !== "ok" ? "needs attention" : subscription.status}
                      </Badge>
                      {lastScan ? (
                        <p
                          className={`mt-1 text-12 whitespace-nowrap ${lastScan.status === "ok" ? "text-muted" : toneText(scanStatusTone(lastScan.status))}`}
                          title={lastScan.startedAt.toISOString()}
                        >
                          {lastScan.status === "ok" ? "Checked" : scanStatusLabel(lastScan.status)} {relativeTime(lastScan.startedAt, now)}
                        </p>
                      ) : (
                        <p className="mt-1 text-12 whitespace-nowrap text-muted">{needsSource ? "Waiting for a source" : "Never scanned"}</p>
                      )}
                    </>
                  )}
                  {discovering && <p className="mt-1 text-12 text-info">{activityLabel(activityType, activityState, workerState)}{activityState === "running" && workerState && workerState !== "healthy" && <> · <Link href="/health" className="underline">Check Health</Link></>}</p>}
                  {(sourceType || lastScan) && <details className="mt-1 text-12 text-muted"><summary className="min-h-11 cursor-pointer py-2 underline">Monitoring details</summary>
                    {sourceType && <p>Source: {sourceType}</p>}
                    {lastScan && <p>Last check: {lastScan.startedAt.toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" })} UK time · {scanStatusLabel(lastScan.status)}</p>}
                  </details>}
                </TD>
                <TD>
                  {/* Refresh is occasional, so it sits in the row's Manage menu rather than beside it. */}
                  <CompanyManageMenu companyId={company.id} companyName={company.name} status={subscription.status}
                    extra="refresh" running={activityState === "running"} monitoringIssue={activityState === "running" && workerState !== "healthy" ? workerState ?? undefined : undefined}
                    blockedReason={unverified ? VERIFY_SENTENCE : undefined} />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table></div>
        <div className="grid gap-3 md:hidden" aria-label="Tracked companies">
          {rows.map(({ company, subscription, lastScan, openRoles, reviewRoles, shortlistedRoles, sourceType, discovering, activityState, activityType, needsSource, lastDiscovery }) => (
            <article key={company.id} className="min-w-0 border-2 border-line p-4">
              <div className="flex min-w-0 items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <Link prefetch={false} href={`/companies/${company.id}`} className="flex min-h-11 items-center gap-2 font-semibold text-fg underline">
                    <CompanyFavicon {...companyIcon(company)} /><span className="min-w-0 truncate">{company.name}</span>
                  </Link>
                  <a href={company.homepageUrl} target="_blank" rel="noopener noreferrer" className="block min-h-11 truncate py-2 text-12 text-muted underline">{company.domain}</a>
                </div>
                <CompanyManageMenu companyId={company.id} companyName={company.name} status={subscription.status}
                  extra="refresh" running={activityState === "running"} monitoringIssue={activityState === "running" && workerState !== "healthy" ? workerState ?? undefined : undefined}
                  blockedReason={unverified ? VERIFY_SENTENCE : undefined} />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-12">
                {needsSource && !discovering && subscription.status === "active" ? <Badge tone="amber">no careers source</Badge>
                  : <Badge tone={subscription.status === "active" && lastScan && lastScan.status !== "ok" ? "amber" : companyStatusTone(subscription.status)}>
                    {subscription.status === "active" && lastScan && lastScan.status !== "ok" ? "needs attention" : subscription.status}
                  </Badge>}
                {discovering && <span className="text-info">{activityLabel(activityType, activityState, workerState)}{activityState === "running" && workerState && workerState !== "healthy" && <> · <Link href="/health" className="underline">Check Health</Link></>}</span>}
              </div>
              {needsSource && !discovering && subscription.status === "active" && <p className="mt-2 text-13 text-muted">
                {lastDiscovery === "not_found" ? "Careers source not found." : lastDiscovery === "needs_confirmation" ? "Careers source needs confirming." : "No careers source yet."}{" "}
                <Link prefetch={false} href={`/companies/${company.id}#careers-url`} className="text-fg underline">Add careers URL</Link>
              </p>}
              <p className="mt-2 text-12 text-muted">{lastScan ? `${lastScan.status === "ok" ? "Checked" : scanStatusLabel(lastScan.status)} ${relativeTime(lastScan.startedAt, now)}` : needsSource ? "Waiting for a source" : "Never scanned"}</p>
              {(sourceType || lastScan) && <details className="mt-2 text-12 text-muted"><summary className="min-h-11 cursor-pointer py-2 underline">Monitoring details</summary>
                {sourceType && <p>Source: {sourceType}</p>}
                {lastScan && <p>Last check: {lastScan.startedAt.toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" })} UK time · {scanStatusLabel(lastScan.status)}</p>}
              </details>}
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
