import { RoleWorkspace } from "@/components/RoleWorkspace";
import type { RawSearchParams } from "@/lib/queries/jobs";
import { SettingsForm } from "@/components/SettingsForm";
import { notFound } from "next/navigation";
import {
  archiveCompany,
  disableSource,
  enableSource,
  importPosting,
  markSourceConfirmed,
  pasteDiscoveryUrl,
  pauseCompany,
  refreshCompanyLogo,
  refreshCompanyProfile,
  rediscoverCompany,
  rescanCompany,
  resumeCompany,
  suggestCompanyName,
  unfollowCompany,
  useDiscoveryCandidate,
} from "@/app/actions/companies";
import { CompanyFavicon } from "@/components/CompanyFavicon";
import { CompanyNotepad } from "@/components/CompanyNotepad";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Badge, companyStatusTone, discoveryStatusTone, scanStatusTone, sourceStatusTone } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { inputClass, labelClass } from "@/components/Field";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { companyIcon } from "@/lib/company-icon";
import { relativeTime } from "@/lib/format";
import { getCompanyWorkStatus } from "@/lib/work-status";
import {
  companyDiscoveryState,
  companyFollowerCount,
  getCompany,
  getCompanyProfile,
  getCompanyScans,
  getCompanySources,
  getLatestDiscoveryRun,
  pendingNameSuggestion,
  recentPostingImports,
  ungatedUserPostings,
  type PostingImportRow,
} from "@/lib/queries/companies";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

interface DiscoveryCandidateView {
  spec?: { type?: string; url?: string; apiUrl?: string; atsSlug?: string; atsSite?: string };
  confidence?: number;
  method?: string;
  evidence?: string[];
  sample?: Array<{ title?: string; url?: string; location?: string }>;
  count?: number;
  companyName?: string;
}

/** The prompt a role outside the gate earns: it is here because it was asked for, not matched. */
function KeywordPrompt() {
  return (
    <p className="text-12 text-muted">
      It is outside your filters, so a scan would not have caught it.{" "}
      <a href="/settings#keywords" className="text-fg underline">Update your keywords</a> so similar roles reach your table.
    </p>
  );
}

/** What one queued, finished or failed import says for itself. */
function ImportStatus({ row, companyId }: { row: PostingImportRow; companyId: string }) {
  let host = row.url;
  try { host = new URL(row.url).host; } catch { /* the stored URL is whatever was pasted */ }
  if (row.status === "queued" || row.status === "running") return <p className="text-14 text-muted">Importing {host}…</p>;
  if (row.status === "failed") {
    return (
      <div className="space-y-1">
        <p className="text-14 text-danger">{row.error ?? `Could not import ${host}.`}</p>
        <p className="text-12 text-muted">Try again — paste the link above.</p>
      </div>
    );
  }
  const result = row.result;
  if (!result || result.ok !== true) return <p className="text-14 text-danger">{result?.reason ?? `Could not import ${host}.`}</p>;
  const gate = result.gate;
  const outsideFilters = !!gate && (gate.keywordMatched === false || gate.locationOk === false || gate.excluded);
  return (
    <div className="space-y-1">
      <p className="text-14">
        Added «<a href={`/companies/${companyId}?view=auto-matched#roles`} className="text-fg underline">{result.title ?? host}</a>»
        {result.existing && <span className="text-muted"> · already in the catalogue</span>}
      </p>
      {outsideFilters && <KeywordPrompt />}
    </div>
  );
}

export default async function CompanyDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<RawSearchParams> }) {
  const user = await requireUser();
  const { id } = await params;
  const company = await getCompany(user.id, id);
  if (!company) notFound();
  const admin = user.role === "admin";

  const [sources, latestRun, scans, profile, followers, discoveryState, imports, ungated, suggestion, work] = await Promise.all([
    getCompanySources(id),
    getLatestDiscoveryRun(id),
    getCompanyScans(id, 20),
    getCompanyProfile(id),
    companyFollowerCount(id),
    companyDiscoveryState(id),
    recentPostingImports(user.id, id, 5),
    ungatedUserPostings(user.id, id),
    pendingNameSuggestion(user.id, id),
    getCompanyWorkStatus(user.id),
  ]);

  const now = new Date();
  const candidates = (latestRun?.candidates ?? []) as DiscoveryCandidateView[];
  const subscription = company.subscription;
  const icon = companyIcon(company);
  /**
   * Nobody has a working careers page for this company yet: either no source a scan would use, or
   * a discovery run that stopped and asked. Everything needed to fix that is in one card, and the
   * card is gone the moment it is fixed.
   */
  const needsSetup =
    !sources.some(source => source.status === "active" || source.status === "failing") ||
    latestRun?.status === "needs_confirmation" ||
    latestRun?.status === "not_found";

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <CompanyFavicon src={icon.src} domain={icon.domain} size={32} />
            {company.name}
            <Badge tone={companyStatusTone(subscription.status)}>{subscription.status}</Badge>
          </span>
        }
        description={
          <>
            <a href={company.homepageUrl} target="_blank" rel="noopener noreferrer" className="break-all no-underline hover:underline">
              {company.homepageUrl}
            </a>
            <span className="block text-12 text-faint">Shared catalogue entry · followed by {followers} {followers === 1 ? "account" : "accounts"} · scanned once a day for all of them</span>
          </>
        }
        actions={<>
          <form action={rescanCompany.bind(null, company.id)}>
            <Button type="submit" size="sm" title="A scan made in the last half hour is reused rather than repeated">
              Rescan
            </Button>
          </form>
          <form action={rediscoverCompany.bind(null, company.id)}>
            <Button type="submit" size="sm">
              Re-discover
            </Button>
          </form>
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
          ) : (
            <form action={resumeCompany.bind(null, company.id)}>
              <Button type="submit" size="sm">
                Follow again
              </Button>
            </form>
          )}
          {subscription.status !== "archived" && (
            <form action={archiveCompany.bind(null, company.id)}>
              <ConfirmSubmitButton variant="ghost" confirmMessage={`Archive ${company.name}? It leaves your inbox; other followers are unaffected.`}>Archive</ConfirmSubmitButton>
            </form>
          )}
          <form action={unfollowCompany.bind(null, company.id)}>
            <ConfirmSubmitButton variant="ghost" confirmMessage={`Stop following ${company.name}? Its roles leave your table. Your decision snapshots are retained.`}>Stop following</ConfirmSubmitButton>
          </form>
        </>}
      />

      {work.active && <AutoRefresh message="Work is pending for your companies. Status updates automatically." />}

      {needsSetup && (
        <div id="careers-url">
          <Card title="Set up this company">
            <div className="space-y-5">
              <p className="text-14 text-muted">
                {discoveryState
                  ? "Discovery is looking for this company's careers page. Paste the URL if you know it."
                  : "Nobody has confirmed a careers page for this company yet. Paste its careers or board URL, or pick a candidate discovery found."}
              </p>

              <form action={pasteDiscoveryUrl.bind(null, company.id)} className="flex flex-wrap items-end gap-3">
                <label className="flex flex-1 flex-col gap-1.5">
                  <span className={labelClass}>Careers or board URL</span>
                  <input name="url" type="text" required maxLength={2048} placeholder="https://boards.greenhouse.io/acme" className={inputClass} />
                </label>
                <Button type="submit" size="sm">Try this URL</Button>
              </form>

              {candidates.length > 0 && (
                <div className="space-y-3">
                  <h3 className="ds-label">Candidates discovery found</h3>
                  {candidates.map((candidate, index) => (
                    <div key={index} className="border-2 border-line-muted p-3 text-14">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        {candidate.spec?.type && <Badge tone="neutral">{candidate.spec.type}</Badge>}
                        <span className="text-12 text-muted">{Math.round((candidate.confidence ?? 0) * 100)}% · {candidate.method}</span>
                      </div>
                      {candidate.spec?.url && (
                        <a href={candidate.spec.url} target="_blank" rel="noopener noreferrer" className="block truncate text-fg no-underline hover:underline">
                          {candidate.spec.url}
                        </a>
                      )}
                      {candidate.evidence && candidate.evidence.length > 0 && (
                        <ul className="mt-1 list-inside list-disc text-12 text-muted">
                          {candidate.evidence.map((line, i) => <li key={i}>{line}</li>)}
                        </ul>
                      )}
                      {candidate.sample && candidate.sample.length > 0 && (
                        <ul className="mt-1 space-y-0.5 text-12 text-muted">
                          {candidate.sample.slice(0, 3).map((sample, i) => <li key={i}>· {sample.title}</li>)}
                        </ul>
                      )}
                      <form action={useDiscoveryCandidate.bind(null, latestRun!.id, index)} className="mt-2">
                        <Button type="submit" variant="primary" size="sm">Use this</Button>
                      </form>
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-2">
                <h3 className="ds-label">Suggest a name</h3>
                <SettingsForm action={suggestCompanyName.bind(null, company.id)} submitLabel={admin ? "Rename" : "Suggest"}>
                  <p className="text-12 text-muted">
                    The name and website are shared by every follower, so a change is an administrator&rsquo;s.
                    {suggestion && <span className="block text-fg">You suggested «{suggestion.name}» · awaiting an administrator</span>}
                  </p>
                  <label className="flex flex-col gap-1.5 text-14">
                    <span className={labelClass}>Company name</span>
                    <input name="name" defaultValue={suggestion?.name ?? company.name} required maxLength={200} className={inputClass} />
                  </label>
                </SettingsForm>
              </div>
            </div>
          </Card>
        </div>
      )}

      <Card title="Roles">
        <RoleWorkspace userId={user.id} searchParams={await searchParams} companyId={id} />
      </Card>

      <Card title="Add a role">
        <div className="space-y-5">
          <form action={importPosting.bind(null, company.id)} className="flex flex-wrap items-end gap-3">
            <label className="flex flex-1 flex-col gap-1.5">
              <span className={labelClass}>Posting URL</span>
              <input
                name="url"
                type="url"
                required
                maxLength={2048}
                placeholder="https://job-boards.greenhouse.io/acme/jobs/1234567"
                className={inputClass}
              />
              <span className="text-12 text-muted">Paste the full link to one posting the scan has not collected. It is checked, stored and added to your table.</span>
            </label>
            <Button type="submit" variant="primary" size="sm">Add role</Button>
          </form>

          {imports.length > 0 && (
            <ul className="space-y-2 border-t-2 border-line-faint pt-4">
              {imports.map(row => (
                <li key={row.id}>
                  <ImportStatus row={row} companyId={company.id} />
                  <p className="text-12 text-faint" title={row.createdAt.toISOString()}>{relativeTime(row.createdAt, now)}</p>
                </li>
              ))}
            </ul>
          )}

          {ungated.length > 0 && (
            <div className="space-y-2 border-t-2 border-line-faint pt-4">
              <h3 className="ds-label">Roles you added that are outside your filters</h3>
              <ul className="space-y-1 text-14">
                {ungated.map(role => (
                  <li key={role.jobId}>
                    <a href={role.url} target="_blank" rel="noopener noreferrer" className="text-fg no-underline hover:underline">{role.title} ↗</a>
                  </li>
                ))}
              </ul>
              <KeywordPrompt />
            </div>
          )}
        </div>
      </Card>

      <Card title="Notepad">
        <CompanyNotepad companyId={company.id} notes={subscription.notes ?? ""} />
      </Card>

      {admin && (
        <details className="border-2 border-line bg-raised">
          <summary className="ds-pixel cursor-pointer px-4 py-2.5 text-12 text-fg">Catalogue diagnostics</summary>
          <div className="space-y-6 border-t-2 border-line p-4">
            <section className="space-y-3">
              <h3 className="ds-label">Sources</h3>
              {sources.length === 0 ? (
                <EmptyState title="No careers source yet" description="Run discovery, or paste a careers/board URL in Set up this company." />
              ) : (
                sources.map((s) => (
                  <div key={s.id} className="border-2 border-line-muted p-3 text-14">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <Badge tone="neutral">{s.type}</Badge>
                      <Badge tone={sourceStatusTone(s.status)}>{s.status === "needs_confirmation" ? "needs confirmation" : s.status}</Badge>
                      <span className="text-12 text-muted">{Math.round(s.confidence * 100)}% confidence</span>
                      {s.confirmedByUser && <span className="text-12 text-muted">· confirmed by a follower</span>}
                      {s.discoveryMethod && <span className="text-12 text-muted">· via {s.discoveryMethod}</span>}
                    </div>
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="block truncate text-fg no-underline hover:underline">
                      {s.url}
                    </a>
                    <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-12 text-muted sm:grid-cols-4">
                      {s.apiUrl && (
                        <div>
                          <dt className="inline">API: </dt>
                          <dd className="inline truncate">{s.apiUrl}</dd>
                        </div>
                      )}
                      {s.atsSlug && (
                        <div>
                          <dt className="inline">Slug: </dt>
                          <dd className="inline">{s.atsSlug}</dd>
                        </div>
                      )}
                      <div>
                        <dt className="inline">Failures: </dt>
                        <dd className="inline">{s.consecutiveFailures}</dd>
                      </div>
                      <div>
                        <dt className="inline">Last OK scan: </dt>
                        <dd className="inline">{s.lastOkScanAt ? relativeTime(s.lastOkScanAt, now) : "never"}</dd>
                      </div>
                      {s.lastPostingsCount !== null && (
                        <div>
                          <dt className="inline">Last postings: </dt>
                          <dd className="inline">{s.lastPostingsCount}</dd>
                        </div>
                      )}
                    </dl>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {s.status === "disabled" ? (
                        <form action={enableSource.bind(null, s.id)}>
                          <Button type="submit" size="sm">Enable</Button>
                        </form>
                      ) : (
                        <form action={disableSource.bind(null, s.id)}>
                          <Button type="submit" size="sm">Disable</Button>
                        </form>
                      )}
                      {!s.confirmedByUser && (
                        <form action={markSourceConfirmed.bind(null, s.id)}>
                          <Button type="submit" size="sm">Mark confirmed</Button>
                        </form>
                      )}
                    </div>
                  </div>
                ))
              )}
            </section>

            <section className="space-y-3">
              <h3 className="ds-label">
                Scans
                {latestRun && <span className="ml-2"><Badge tone={discoveryStatusTone(latestRun.status)}>discovery: {latestRun.status}</Badge></span>}
              </h3>
              {scans.length === 0 ? (
                <EmptyState title="No scans yet" description="A scan runs automatically once a source is active, or trigger one with Rescan above." />
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <TH>Started</TH>
                      <TH>Status</TH>
                      <TH>Method</TH>
                      <TH>Postings</TH>
                      <TH>New / Closed</TH>
                      <TH>Duration</TH>
                      <TH>Error</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {scans.map((s) => (
                      <TR key={s.id}>
                        <TD className="whitespace-nowrap" title={s.startedAt.toISOString()}>{relativeTime(s.startedAt, now)}</TD>
                        <TD><Badge tone={scanStatusTone(s.status)}>{s.status}</Badge></TD>
                        <TD>{s.fetchMethod ?? "—"}</TD>
                        <TD>{s.postingsFound}</TD>
                        <TD>{s.newCount} / {s.closedCount}</TD>
                        <TD>{s.durationMs !== null ? `${(s.durationMs / 1000).toFixed(1)}s` : "—"}</TD>
                        <TD className="max-w-[24rem] whitespace-normal break-words text-danger" title={s.error ?? undefined}>{s.error ?? ""}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </section>

            {latestRun && Array.isArray(latestRun.log) && latestRun.log.length > 0 && (
              <section className="space-y-2">
                <h3 className="ds-label">Discovery log</h3>
                <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap border-2 border-line-muted p-3 text-12 text-muted">
                  {(latestRun.log as unknown[]).map((line) => String(line)).join("\n")}
                </pre>
              </section>
            )}

            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="ds-label">Company profile</h3>
                <form action={refreshCompanyProfile.bind(null, company.id)}>
                  <Button type="submit" size="sm">Refresh profile</Button>
                </form>
              </div>
              {profile ? (
                <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-14 sm:grid-cols-2">
                  {profile.oneLiner && <div className="sm:col-span-2"><dd className="text-fg">{profile.oneLiner}</dd></div>}
                  {profile.sector && <div><dt className="inline text-12 text-muted">Sector: </dt><dd className="inline">{profile.sector}</dd></div>}
                  {profile.stage && <div><dt className="inline text-12 text-muted">Stage: </dt><dd className="inline">{profile.stage}</dd></div>}
                  {profile.sizeBand && <div><dt className="inline text-12 text-muted">Size: </dt><dd className="inline">{profile.sizeBand}</dd></div>}
                  {profile.hqCountry && <div><dt className="inline text-12 text-muted">HQ: </dt><dd className="inline">{profile.hqCountry}</dd></div>}
                  {profile.tags.length > 0 && (
                    <div className="sm:col-span-2 mt-1 flex flex-wrap gap-1">
                      {profile.tags.map((t) => <Badge key={t} tone="neutral">{t}</Badge>)}
                    </div>
                  )}
                </dl>
              ) : (
                <EmptyState title="No profile yet" description="Refresh to generate a company profile from its homepage and about page." />
              )}
            </section>

            <section className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="ds-label">Logo</h3>
                <form action={refreshCompanyLogo.bind(null, company.id)}>
                  <Button type="submit" size="sm">Refresh logo</Button>
                </form>
              </div>
              <p className="text-14 text-muted">
                {company.logoFetchedAt
                  ? <>Captured {relativeTime(company.logoFetchedAt, now)} from {company.faviconUrl ?? "the company site"}.</>
                  : company.logoAttempts > 0
                    ? <>Not captured. {company.logoAttempts} {company.logoAttempts === 1 ? "attempt" : "attempts"}{company.logoNextAttemptAt ? `, next ${relativeTime(company.logoNextAttemptAt, now)}` : ""}{company.logoError ? `. Last error: ${company.logoError}` : "."}</>
                    : <>Not captured yet. The daily sweep takes up to 200 companies a day, oldest first.</>}
              </p>
            </section>

            <p className="text-12 text-muted">
              Deleting the company or a source for every follower is done from{" "}
              <a href={`/admin/catalogue?q=${encodeURIComponent(company.domain)}`} className="text-fg underline">Admin › Company catalogue</a>.
            </p>
          </div>
        </details>
      )}
    </div>
  );
}
