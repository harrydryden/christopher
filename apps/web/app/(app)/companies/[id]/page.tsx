import { Pagination, pageNumber } from "@/components/Pagination";
import { companyRoleCount } from "@/lib/queries/companies";
import { SettingsForm } from "@/components/SettingsForm";
import { notFound } from "next/navigation";
import {
  archiveCompany,
  deleteSource,
  deleteCompany,
  disableSource,
  enableSource,
  markSourceConfirmed,
  pasteDiscoveryUrl,
  pauseCompany,
  refreshCompanyProfile,
  rediscoverCompany,
  rescanCompany,
  resumeCompany,
  updateCompanyDetails,
  useDiscoveryCandidate,
} from "@/app/actions/companies";
import { Badge, companyStatusTone, discoveryStatusTone, jobStatusTone, scanStatusTone, sourceStatusTone } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";
import { EmptyState } from "@/components/EmptyState";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { displayStatus, liveFor, formatDuration } from "@christopher/core";
import { relativeTime } from "@/lib/format";
import {
  getCompany,
  getCompanyProfile,
  getCompanyRoles,
  getCompanyScans,
  getCompanySources,
  getLatestDiscoveryRun,
} from "@/lib/queries/companies";

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

export default async function CompanyDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string }> }) {
  const { id } = await params;
  const company = await getCompany(id);
  if (!company) notFound();

  const total = await companyRoleCount(id);
  const page = Math.min(pageNumber((await searchParams).page), Math.max(1, Math.ceil(total / 50)));
  const [sources, latestRun, scans, roles, profile] = await Promise.all([
    getCompanySources(id),
    getLatestDiscoveryRun(id),
    getCompanyScans(id, 20),
    getCompanyRoles(id, page),
    getCompanyProfile(id),
  ]);

  const now = new Date();
  const needsConfirmation = latestRun && (latestRun.status === "needs_confirmation" || latestRun.status === "not_found");
  const candidates = (latestRun?.candidates ?? []) as DiscoveryCandidateView[];

  return (
    <div className="space-y-6">
      <div data-page-header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          {company.faviconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={company.faviconUrl} alt="" width={28} height={28} referrerPolicy="no-referrer" className="rounded" />
          ) : (
            <span className="inline-block h-7 w-7 rounded bg-slate-200" />
          )}
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-slate-900">{company.name}</h1>
              <Badge tone={companyStatusTone(company.status)}>{company.status}</Badge>
            </div>
            <a href={company.homepageUrl} target="_blank" rel="noopener noreferrer" data-header-description className="break-all text-sm hover:underline">
              {company.homepageUrl}
            </a>
          </div>
        </div>
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
      </div>

      <Card title="Details">
        <SettingsForm action={updateCompanyDetails.bind(null, company.id)}>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-slate-500">Name</span>
            <input
              name="name"
              defaultValue={company.name}
              className="w-full max-w-sm rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-indigo-500"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-slate-500">Main website</span>
            <input name="homepageUrl" defaultValue={company.homepageUrl} required maxLength={2048}
              className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm" />
            <span className="text-xs text-slate-500">Careers sources are managed separately below. Use Re-discover after correcting a domain to find its careers page.</span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-slate-500">Notes</span>
            <textarea
              name="notes"
              defaultValue={company.notes ?? ""}
              rows={3}
              className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-indigo-500"
            />
          </label>
        </SettingsForm>
      </Card>

      <Card title="Careers URL">
          <form action={pasteDiscoveryUrl.bind(null, company.id)} className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-200 pt-3">
            <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-slate-500">
              Paste careers or board URL
              <input
                name="url"
                type="text"
                required
                placeholder="https://boards.greenhouse.io/acme"
                className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-indigo-500"
              />
            </label>
            <Button type="submit" size="sm">
              Try this URL
            </Button>
          </form>
        <p className="mt-2 text-xs text-slate-500">Paste a known careers board at any time, including while homepage discovery is queued.</p>
      </Card>

      <Card title="Sources">
        {sources.length === 0 ? (
          <EmptyState title="No careers source yet" description="Run discovery, or paste a careers/board URL above." />
        ) : (
          <div className="space-y-3">
            {sources.map((s) => (
              <div key={s.id} className="rounded-md border border-slate-200 p-3 text-sm">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{s.type}</Badge>
                  <Badge tone={sourceStatusTone(s.status)}>{s.status === "needs_confirmation" ? "needs confirmation" : s.status}</Badge>
                  <span className="text-xs text-slate-500">{Math.round(s.confidence * 100)}% confidence</span>
                  {s.confirmedByUser && <span className="text-xs text-slate-500">· confirmed by you</span>}
                  {s.discoveryMethod && <span className="text-xs text-slate-500">· via {s.discoveryMethod}</span>}
                </div>
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="block truncate text-slate-600 hover:underline">
                  {s.url}
                </a>
                <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-slate-500 sm:grid-cols-4">
                  {s.apiUrl && (
                    <div>
                      <dt className="inline text-slate-500">API: </dt>
                      <dd className="inline truncate">{s.apiUrl}</dd>
                    </div>
                  )}
                  {s.atsSlug && (
                    <div>
                      <dt className="inline text-slate-500">Slug: </dt>
                      <dd className="inline">{s.atsSlug}</dd>
                    </div>
                  )}
                  <div>
                    <dt className="inline text-slate-500">Failures: </dt>
                    <dd className="inline">{s.consecutiveFailures}</dd>
                  </div>
                  <div>
                    <dt className="inline text-slate-500">Last OK scan: </dt>
                    <dd className="inline">{s.lastOkScanAt ? relativeTime(s.lastOkScanAt, now) : "never"}</dd>
                  </div>
                  {s.lastPostingsCount !== null && (
                    <div>
                      <dt className="inline text-slate-500">Last postings: </dt>
                      <dd className="inline">{s.lastPostingsCount}</dd>
                    </div>
                  )}
                </dl>
                <div className="mt-2 flex gap-1.5">
                  {s.status === "disabled" ? (
                    <form action={enableSource.bind(null, s.id)}>
                      <Button type="submit" size="sm">
                        Enable
                      </Button>
                    </form>
                  ) : (
                    <form action={disableSource.bind(null, s.id)}>
                      <Button type="submit" size="sm">
                        Disable
                      </Button>
                    </form>
                  )}
                  {!s.confirmedByUser && (
                    <form action={markSourceConfirmed.bind(null, s.id)}>
                      <Button type="submit" size="sm">
                        Mark confirmed
                      </Button>
                    </form>
                  )}
                  <form action={deleteSource.bind(null, s.id)}>
                    <ConfirmSubmitButton confirmMessage="Delete this source? Its scan history stays, but it will no longer be scanned.">Delete</ConfirmSubmitButton>
                  </form>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {needsConfirmation && (
        <Card title="Confirm a careers source">
          <p className="mb-3 text-sm text-slate-500">
            {latestRun!.status === "not_found"
              ? "Discovery could not find a careers page on its own. Pick a candidate below, or paste a URL."
              : "Discovery found candidates but is not confident enough to pick automatically. Confirm one below."}
          </p>
          <div className="space-y-3">
            {candidates.map((c, index) => (
              <div key={index} className="rounded-md border border-slate-200 p-3 text-sm">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  {c.spec?.type && <Badge tone="neutral">{c.spec.type}</Badge>}
                  <span className="text-xs text-slate-500">{Math.round((c.confidence ?? 0) * 100)}% · {c.method}</span>
                </div>
                {c.spec?.url && (
                  <a href={c.spec.url} target="_blank" rel="noopener noreferrer" className="block truncate text-slate-600 hover:underline">
                    {c.spec.url}
                  </a>
                )}
                {c.evidence && c.evidence.length > 0 && (
                  <ul className="mt-1 list-inside list-disc text-xs text-slate-500">
                    {c.evidence.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
                {c.sample && c.sample.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs text-slate-500">
                    {c.sample.slice(0, 3).map((s, i) => (
                      <li key={i}>· {s.title}</li>
                    ))}
                  </ul>
                )}
                <form action={useDiscoveryCandidate.bind(null, latestRun!.id, index)} className="mt-2">
                  <Button type="submit" variant="primary" size="sm">
                    Use this
                  </Button>
                </form>
              </div>
            ))}
            {candidates.length === 0 && <p className="text-sm text-slate-500">No candidates were found.</p>}
          </div>

        </Card>
      )}

      <Card title="Scans" actions={latestRun && <Badge tone={discoveryStatusTone(latestRun.status)}>discovery: {latestRun.status}</Badge>}>
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
                  <TD className="whitespace-nowrap" title={s.startedAt.toISOString()}>
                    {relativeTime(s.startedAt, now)}
                  </TD>
                  <TD>
                    <Badge tone={scanStatusTone(s.status)}>{s.status}</Badge>
                  </TD>
                  <TD>{s.fetchMethod ?? "—"}</TD>
                  <TD>{s.postingsFound}</TD>
                  <TD>
                    {s.newCount} / {s.closedCount}
                  </TD>
                  <TD>{s.durationMs !== null ? `${(s.durationMs / 1000).toFixed(1)}s` : "—"}</TD>
                  <TD className="max-w-[24rem] whitespace-normal break-words text-red-600" title={s.error ?? undefined}>
                    {s.error ?? ""}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card title={`Roles (${total})`}>
        <Pagination page={page} total={total} path={`/companies/${id}`}/>
        {roles.length === 0 ? (
          <EmptyState
            title={scans.some(s => s.status === "ok") ? "No roles retained" : "No roles seen yet"}
            description={scans.some(s => s.status === "ok")
              ? "Scanning has completed. Roles that pass your filters or are retained for tracking appear here. See the scan history above for the number checked."
              : "Roles appear here after the first successful scan."}
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Title</TH>
                <TH>Location</TH>
                <TH>Status</TH>
                <TH>In table</TH>
                <TH>Fit</TH>
                <TH>Live for</TH>
              </tr>
            </THead>
            <TBody>
              {roles.map((job) => (
                <TR key={job.id}>
                  <TD>
                    <a href={job.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                      {job.title}
                    </a>
                  </TD>
                  <TD>{job.location ?? "—"}</TD>
                  <TD>
                    <Badge tone={jobStatusTone(displayStatus(job, now))}>{displayStatus(job, now)}</Badge>
                  </TD>
                  <TD>
                    <div className="flex gap-1">
                      {job.inTable ? <Badge tone="blue">in table</Badge> : <Badge tone="gray">not in table</Badge>}
                      {job.nearMiss && <Badge tone="amber">near miss</Badge>}
                    </div>
                  </TD>
                  <TD>{job.fitScore ?? "—"}</TD>
                  <TD>{formatDuration(liveFor(job, now).days)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card title="Company profile" actions={
        <form action={refreshCompanyProfile.bind(null, company.id)}>
          <Button type="submit" size="sm">
            Refresh profile
          </Button>
        </form>
      }>
        {profile ? (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {profile.oneLiner && (
              <div className="sm:col-span-2">
                <dd className="text-slate-700">{profile.oneLiner}</dd>
              </div>
            )}
            {profile.sector && (
              <div>
                <dt className="inline text-xs text-slate-500">Sector: </dt>
                <dd className="inline">{profile.sector}</dd>
              </div>
            )}
            {profile.stage && (
              <div>
                <dt className="inline text-xs text-slate-500">Stage: </dt>
                <dd className="inline">{profile.stage}</dd>
              </div>
            )}
            {profile.sizeBand && (
              <div>
                <dt className="inline text-xs text-slate-500">Size: </dt>
                <dd className="inline">{profile.sizeBand}</dd>
              </div>
            )}
            {profile.hqCountry && (
              <div>
                <dt className="inline text-xs text-slate-500">HQ: </dt>
                <dd className="inline">{profile.hqCountry}</dd>
              </div>
            )}
            {profile.tags.length > 0 && (
              <div className="sm:col-span-2 mt-1 flex flex-wrap gap-1">
                {profile.tags.map((t) => (
                  <Badge key={t} tone="neutral">
                    {t}
                  </Badge>
                ))}
              </div>
            )}
          </dl>
        ) : (
          <EmptyState title="No profile yet" description="Refresh to generate a company profile from its homepage and about page." />
        )}
      </Card>

      <Card title="Delete company">
        <p className="mb-3 text-sm text-slate-500">Remove this company, its sources and roles. Your decision snapshots remain in the learning history.</p>
        <form action={deleteCompany.bind(null, company.id)}>
          <ConfirmSubmitButton confirmMessage={`Delete ${company.name} and all its roles? Decision snapshots will be retained.`}>Delete company</ConfirmSubmitButton>
        </form>
      </Card>

      {latestRun && Array.isArray(latestRun.log) && latestRun.log.length > 0 && (
        <section className="rounded-lg border border-slate-200">
          <h3 className="px-4 py-2.5 text-sm font-semibold text-slate-900">Discovery log</h3>
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap border-t border-slate-200 p-4 text-xs text-slate-600">
            {(latestRun.log as unknown[]).map((line) => String(line)).join("\n")}
          </pre>
        </section>
      )}
    </div>
  );
}
