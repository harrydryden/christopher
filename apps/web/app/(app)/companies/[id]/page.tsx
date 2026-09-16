import { RoleWorkspace } from "@/components/RoleWorkspace";
import type { RawSearchParams } from "@/lib/queries/jobs";
import { SettingsForm } from "@/components/SettingsForm";
import { notFound } from "next/navigation";
import {
  archiveCompany,
  disableSource,
  enableSource,
  markSourceConfirmed,
  pasteDiscoveryUrl,
  pauseCompany,
  refreshCompanyProfile,
  rediscoverCompany,
  rescanCompany,
  resumeCompany,
  unfollowCompany,
  updateCompanyDetails,
  useDiscoveryCandidate,
} from "@/app/actions/companies";
import { CompanyFavicon } from "@/components/CompanyFavicon";
import { Badge, companyStatusTone, discoveryStatusTone, scanStatusTone, sourceStatusTone } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { inputClass, labelClass } from "@/components/Field";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { relativeTime } from "@/lib/format";
import {
  companyFollowerCount,
  getCompany,
  getCompanyProfile,
  getCompanyScans,
  getCompanySources,
  getLatestDiscoveryRun,
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

export default async function CompanyDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<RawSearchParams> }) {
  const user = await requireUser();
  const { id } = await params;
  const company = await getCompany(user.id, id);
  if (!company) notFound();
  const admin = user.role === "admin";

  const [sources, latestRun, scans, profile, followers] = await Promise.all([
    getCompanySources(id),
    getLatestDiscoveryRun(id),
    getCompanyScans(id, 20),
    getCompanyProfile(id),
    companyFollowerCount(id),
  ]);

  const now = new Date();
  const needsConfirmation = latestRun && (latestRun.status === "needs_confirmation" || latestRun.status === "not_found");
  const candidates = (latestRun?.candidates ?? []) as DiscoveryCandidateView[];
  const subscription = company.subscription;

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <CompanyFavicon src={company.faviconUrl} domain={company.domain} size={32} />
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
        </>}
      />

      <Card title="Roles">
        <RoleWorkspace userId={user.id} searchParams={await searchParams} companyId={id} />
      </Card>

      <Card title="Details">
        <SettingsForm action={updateCompanyDetails.bind(null, company.id)}>
          <p className="text-14 text-muted">
            The name and website are shared by every follower.
            {admin
              ? <> Edit them in <a href={`/admin/catalogue?q=${encodeURIComponent(company.domain)}`} className="text-fg underline">Admin › Company catalogue</a>.</>
              : " An administrator can change them from the catalogue."}
          </p>
          <label className="flex flex-col gap-1.5 text-14">
            <span className={labelClass}>Your notes</span>
            <textarea name="notes" defaultValue={subscription.notes ?? ""} rows={3} className={`resize-y ${inputClass}`} />
          </label>
        </SettingsForm>
      </Card>

      <div id="careers-url">
      <Card title="Careers URL">
          <form action={pasteDiscoveryUrl.bind(null, company.id)} className="flex flex-wrap items-end gap-3">
            <label className="flex flex-1 flex-col gap-1.5">
              <span className={labelClass}>Paste careers or board URL</span>
              <input
                name="url"
                type="text"
                required
                placeholder="https://boards.greenhouse.io/acme"
                className={inputClass}
              />
            </label>
            <Button type="submit" size="sm">
              Try this URL
            </Button>
          </form>
        <p className="mt-2 text-12 text-muted">Paste a known careers board at any time, including while homepage discovery is queued. A confirmed source serves every follower.</p>
      </Card>
      </div>

      <Card title="Sources">
        {sources.length === 0 ? (
          <EmptyState title="No careers source yet" description="Run discovery, or paste a careers/board URL above." />
        ) : (
          <div className="space-y-3">
            {sources.map((s) => (
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
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {needsConfirmation && (
        <Card title="Confirm a careers source">
          <p className="mb-3 text-14 text-muted">
            {latestRun!.status === "not_found"
              ? "Discovery could not find a careers page on its own. Pick a candidate below, or paste a URL."
              : "Discovery found candidates but is not confident enough to pick automatically. Confirm one below."}
          </p>
          <div className="space-y-3">
            {candidates.map((c, index) => (
              <div key={index} className="border-2 border-line-muted p-3 text-14">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  {c.spec?.type && <Badge tone="neutral">{c.spec.type}</Badge>}
                  <span className="text-12 text-muted">{Math.round((c.confidence ?? 0) * 100)}% · {c.method}</span>
                </div>
                {c.spec?.url && (
                  <a href={c.spec.url} target="_blank" rel="noopener noreferrer" className="block truncate text-fg no-underline hover:underline">
                    {c.spec.url}
                  </a>
                )}
                {c.evidence && c.evidence.length > 0 && (
                  <ul className="mt-1 list-inside list-disc text-12 text-muted">
                    {c.evidence.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
                {c.sample && c.sample.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-12 text-muted">
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
            {candidates.length === 0 && <p className="text-14 text-muted">No candidates were found.</p>}
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
                  <TD className="max-w-[24rem] whitespace-normal break-words text-danger" title={s.error ?? undefined}>
                    {s.error ?? ""}
                  </TD>
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
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-14 sm:grid-cols-2">
            {profile.oneLiner && (
              <div className="sm:col-span-2">
                <dd className="text-fg">{profile.oneLiner}</dd>
              </div>
            )}
            {profile.sector && (
              <div>
                <dt className="inline text-12 text-muted">Sector: </dt>
                <dd className="inline">{profile.sector}</dd>
              </div>
            )}
            {profile.stage && (
              <div>
                <dt className="inline text-12 text-muted">Stage: </dt>
                <dd className="inline">{profile.stage}</dd>
              </div>
            )}
            {profile.sizeBand && (
              <div>
                <dt className="inline text-12 text-muted">Size: </dt>
                <dd className="inline">{profile.sizeBand}</dd>
              </div>
            )}
            {profile.hqCountry && (
              <div>
                <dt className="inline text-12 text-muted">HQ: </dt>
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

      <Card title="Stop following">
        <p className="mb-3 text-14 text-muted">Remove this company from your list. Your decision snapshots stay in your learning history; the company and its scan history remain in the shared catalogue for other followers.</p>
        <form action={unfollowCompany.bind(null, company.id)}>
          <ConfirmSubmitButton confirmMessage={`Stop following ${company.name}? Its roles leave your table. Your decision snapshots are retained.`}>Stop following</ConfirmSubmitButton>
        </form>
        {admin && (
          <p className="mt-4 text-12 text-muted">Deleting the company or a source for every follower is done from <a href={`/admin/catalogue?q=${encodeURIComponent(company.domain)}`} className="text-fg underline">Admin › Company catalogue</a>.</p>
        )}
      </Card>

      {latestRun && Array.isArray(latestRun.log) && latestRun.log.length > 0 && (
        <section className="border-2 border-line bg-raised">
          <h3 className="ds-pixel border-b-2 border-line px-4 py-2.5 text-12 text-fg">Discovery log</h3>
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap p-4 text-12 text-muted">
            {(latestRun.log as unknown[]).map((line) => String(line)).join("\n")}
          </pre>
        </section>
      )}
    </div>
  );
}
