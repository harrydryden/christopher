import { applyNameSuggestion, dismissNameSuggestion, removeCatalogueCompany, removeCatalogueSource, saveCatalogueCompany } from "@/app/actions/admin";
import { Badge, companyStatusTone, scanStatusTone, sourceStatusTone } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { CompanyFavicon } from "@/components/CompanyFavicon";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Pagination, pageNumber } from "@/components/Pagination";
import { SearchForm, SearchPending } from "@/components/SearchForm";
import { SettingsForm } from "@/components/SettingsForm";
import { inputClass, labelClass } from "@/components/Field";
import { requireAdmin } from "@/lib/auth";
import { relativeTime, scanStatusLabel } from "@/lib/format";
import { catalogueCount, listCatalogue, pendingNameSuggestionsFor } from "@/lib/queries/companies";
import { companyIcon } from "@/lib/company-icon";

export const dynamic = "force-dynamic";

export default async function AdminCataloguePage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const admin = await requireAdmin();
  const sp = await searchParams;
  const q = (sp.q ?? "").slice(0, 200);
  const total = await catalogueCount(q);
  const page = Math.min(pageNumber(sp.page), Math.max(1, Math.ceil(total / 50)));
  const rows = await listCatalogue(admin.id, page, q);
  const suggestions = await pendingNameSuggestionsFor(rows.map(row => row.company.id));
  const now = new Date();

  return (
    <div className="space-y-6">
      <PageHeader title="Company catalogue" description="Every company anyone follows, stored once and scanned once a day. Names, websites and sources are shared, so changes here reach every follower." />

      <SearchForm action="/admin/catalogue" className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1.5"><span className={labelClass}>Search the catalogue</span><input name="q" defaultValue={q} maxLength={200} className={`h-11 w-80 ${inputClass}`} /></label>
        <Button type="submit" className="h-11">Search</Button>
        <SearchPending />
        {q && <a className="self-center text-13 underline" href="/admin/catalogue">Clear</a>}
      </SearchForm>
      <Pagination page={page} total={total} path="/admin/catalogue" params={{ q }} />

      {rows.length === 0 ? (
        <EmptyState title={q ? "No matching companies" : "The catalogue is empty"} description={q ? "Try another name or domain." : "Companies appear here as soon as anyone adds one."} />
      ) : (
        rows.map(({ company, followers, followedByViewer, sources, lastScan }) => (
          <Card
            key={company.id}
            title={
              <span className="flex items-center gap-2">
                <CompanyFavicon {...companyIcon(company)} />
                {company.name}
                <Badge tone={companyStatusTone(company.status)}>{company.status}</Badge>
              </span>
            }
            actions={
              <span className="text-12 text-muted">
                {followers} {followers === 1 ? "follower" : "followers"}
                {lastScan ? ` · ${scanStatusLabel(lastScan.status)} ${relativeTime(lastScan.startedAt, now)}` : " · never scanned"}
                {followedByViewer && <> · <a href={`/companies/${company.id}`} className="text-fg underline">your company page</a></>}
              </span>
            }
          >
            <div className="grid gap-4 md:grid-cols-2">
              <SettingsForm action={saveCatalogueCompany.bind(null, company.id)} submitLabel="Save company">
                <label className="flex flex-col gap-1.5 text-14">
                  <span className={labelClass}>Name</span>
                  <input name="name" defaultValue={company.name} maxLength={200} className={inputClass} />
                </label>
                <label className="flex flex-col gap-1.5 text-14">
                  <span className={labelClass}>Main website</span>
                  <input name="homepageUrl" defaultValue={company.homepageUrl} required maxLength={2048} className={inputClass} />
                  <span className="text-12 text-muted">Changing the website refreshes the logo. Followers use Re-discover on their company page to find the careers page again.</span>
                </label>
              </SettingsForm>
              <div className="space-y-3">
                <h3 className="ds-label">Careers sources</h3>
                {sources.length === 0 ? (
                  <p className="text-14 text-muted">None yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {sources.map((source) => (
                      <li key={source.id} className="flex flex-wrap items-center gap-2 text-13">
                        <Badge tone="neutral">{source.type}</Badge>
                        <Badge tone={sourceStatusTone(source.status)}>{source.status === "needs_confirmation" ? "needs confirmation" : source.status}</Badge>
                        <a href={source.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-fg no-underline hover:underline">{source.url}</a>
                        <form action={removeCatalogueSource.bind(null, source.id)}>
                          <ConfirmSubmitButton variant="ghost" confirmMessage="Stop scanning this source for every follower? Its postings and history stay; followers' untouched roles from it move to Archived.">Retire</ConfirmSubmitButton>
                        </form>
                      </li>
                    ))}
                  </ul>
                )}
                {suggestions.filter(suggestion => suggestion.companyId === company.id).map(suggestion => (
                  <div key={suggestion.id} className="flex flex-wrap items-center gap-2 border-2 border-line-muted p-2 text-13">
                    <span className="min-w-0 flex-1">Suggested name «{suggestion.name}» by {suggestion.email} · {relativeTime(suggestion.createdAt, now)}</span>
                    <form action={applyNameSuggestion.bind(null, suggestion.id)}>
                      <Button type="submit" variant="primary" size="sm">Apply</Button>
                    </form>
                    <form action={dismissNameSuggestion.bind(null, suggestion.id)}>
                      <Button type="submit" size="sm">Dismiss</Button>
                    </form>
                  </div>
                ))}
                <form action={removeCatalogueCompany.bind(null, company.id)} className="pt-2">
                  <ConfirmSubmitButton variant="danger" confirmMessage={`Delete ${company.name} for all ${followers} ${followers === 1 ? "follower" : "followers"}, with its sources and postings? Decision snapshots are retained. This cannot be undone.`}>Delete for everyone</ConfirmSubmitButton>
                </form>
              </div>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
