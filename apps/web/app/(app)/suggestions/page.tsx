import Link from "next/link";
import { Pagination, pageNumber } from "@/components/Pagination";
import { and, eq, inArray, sql } from "drizzle-orm";
import { discoverySources, tasks } from "@ava/db/schema";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { DiscoverySources } from "@/components/DiscoverySources";
import { notWorkingSources } from "@/lib/discovery-ux";
import { DiscoverySourceForm } from "@/components/DiscoverySourceForm";
import { findMoreSuggestions } from "@/app/actions/suggestions";
import { addCompanies } from "@/app/actions/companies";
import { AddedNotice } from "@/components/AddedNotice";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { CompanyFavicon } from "@/components/CompanyFavicon";
import { EmptyState } from "@/components/EmptyState";
import { FollowCompanyButton } from "@/components/FollowCompanyButton";
import { PageHeader } from "@/components/PageHeader";
import { RefusalNotice } from "@/components/RefusalNotice";
import { SuggestionDeck } from "@/components/SuggestionDeck";
import { VERIFY_SENTENCE } from "@/components/VerifyNotice";
import { relativeTime } from "@/lib/format";
import { companyIcon } from "@/lib/company-icon";
import { domainFromQuery } from "@/lib/catalogue-query";
import { listPendingSuggestions, listResolvedSuggestions, suggestionCount, type SuggestionRow } from "@/lib/queries/suggestions";
import { searchCatalogue, type CatalogueMatch } from "@/lib/queries/companies";
import { hasChosenGate } from "@/lib/queries/setup";
import { CHOOSE_GATE_SENTENCE } from "@/lib/setup";
import { buttonClass } from "@/components/Button";
import { inputClass, labelClass } from "@/components/Field";
import { SearchForm, SearchPending } from "@/components/SearchForm";
import { needsEmailConfirmation, requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** A suggestion's face: what the deck shows on top and the history lists. */
function SuggestionCardContent({ row }: { row: SuggestionRow }) {
  const { suggestion, profile, similarToNames } = row;
  const verification = suggestion.verification;
  return <div className="space-y-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h2 className="font-semibold"><a href={suggestion.homepageUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">{suggestion.name} ↗</a></h2>
        <p className="text-14 text-muted">{profile?.oneLiner ?? suggestion.domain}</p></div>
      <Badge tone={suggestion.status === "accepted" ? "green" : "neutral"}>{suggestion.status === "pending" ? suggestion.evidence ? "From a source" : "Similar employer" : suggestion.status === "accepted" ? "Added" : suggestion.status === "rejected" ? "Dismissed" : "Expired"}</Badge>
    </div>
    {suggestion.rationale && <p className="text-14 text-fg">{suggestion.rationale}</p>}
    {similarToNames.length > 0 && <p className="text-14 text-muted">Similar to {similarToNames.join(", ")}</p>}
    <div className="flex flex-wrap items-center gap-2 text-14">
      {typeof verification?.openRoles === "number" && <Badge tone="neutral">{verification.openRoles} roles found</Badge>}
      {typeof verification?.matchingRoles === "number" && <Badge tone="blue" title="From a sample of roles, not a complete count. A company can be worth following without a current match.">{verification.matchingRoles} matches in sample</Badge>}
      {verification?.careersSource && <a href={verification.careersSource.url} target="_blank" rel="noreferrer" className="text-fg underline">Careers page ↗</a>}
    </div>
    {suggestion.evidence && <section className="bg-sunken p-3 text-14">
      <h3 className="font-medium">Evidence from {suggestion.evidence.sourceName}</h3>
      <div className="mt-2">{suggestion.evidence.url ? <a href={suggestion.evidence.url} target="_blank" rel="noreferrer" className="text-fg underline">{suggestion.evidence.title} ↗</a> : <p>{suggestion.evidence.title}</p>}
        <blockquote className="mt-2 border-l-2 border-line-muted pl-3 text-muted">“{suggestion.evidence.quote}”</blockquote></div>
    </section>}
    {suggestion.rejectionReason && <p className="text-14 text-muted">Your reason: {suggestion.rejectionReason}</p>}
  </div>;
}

/** The static card the history view lists; pending ones are reviewed in the deck. */
function SuggestionCard({ row }: { row: SuggestionRow }) {
  return <article aria-label={row.suggestion.name} className="border border-line-muted p-4"><SuggestionCardContent row={row}/></article>;
}

/**
 * The one box at the top of Review: a name searches the shared catalogue, and a homepage that is
 * not in it yet can be added from here. Following and adding both wait on a confirmed address and
 * a chosen gate, said beside the controls; the actions refuse on the same rules.
 */
function CatalogueBox({ q, matches, domain, blockedReason }: { q: string; matches: CatalogueMatch[]; domain: string | null; blockedReason: string | null }) {
  const listed = domain !== null && matches.some(match => match.domain === domain);
  return <section aria-label="Follow a company" className="mb-6 border-2 border-line bg-raised p-4">
    <SearchForm action="/suggestions" className="flex flex-wrap items-end gap-3">
      <label className="grid min-w-0 flex-1 gap-1.5"><span className={labelClass}>Search or paste a homepage</span>
        <input name="q" type="search" defaultValue={q} maxLength={200} placeholder="Acme, or acme.com" className={`h-11 w-full ${inputClass}`}/></label>
      <Button type="submit" className="h-11">Search</Button><SearchPending />
      {q && <Link prefetch={false} className="inline-flex min-h-11 items-center text-13 underline" href="/suggestions">Clear</Link>}
    </SearchForm>
    {blockedReason && <p role="status" className="mt-2 text-12 text-warn">{blockedReason}</p>}
    {q && <div className="mt-3">
      {matches.length > 0 && <ul className="divide-y divide-line-faint border-t border-line-faint">
        {matches.map(match => <li key={match.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
          <span className="flex min-w-0 items-center gap-2">
            <CompanyFavicon {...companyIcon(match)}/>
            <span className="min-w-0"><span className="block font-semibold">{match.name}</span><span className="block text-12 text-muted">{match.domain}</span></span>
          </span>
          {match.followStatus === "active" || match.followStatus === "paused"
            ? <Link prefetch={false} href={`/companies/${match.id}`} className="text-13 no-underline hover:underline"><Badge tone="green">{match.followStatus === "paused" ? "Following · paused" : "Following"}</Badge></Link>
            : <FollowCompanyButton companyId={match.id} companyName={match.name} label={match.followStatus === "archived" ? "Follow again" : "Follow"} disabled={!!blockedReason}/>}
        </li>)}
      </ul>}
      {domain && !listed && <form action={addCompanies} className="flex flex-wrap items-center justify-between gap-3 border-t border-line-faint py-2">
        <input type="hidden" name="urls" value={q}/>
        <input type="hidden" name="returnTo" value="/suggestions"/>
        <span className="text-14"><span className="font-semibold">{domain}</span> <span className="text-muted">is not in the catalogue yet.</span></span>
        <Button type="submit" variant="primary" size="sm" className="min-h-11" disabled={!!blockedReason}>Add {domain}</Button>
      </form>}
      {!matches.length && !domain && <p className="text-14 text-muted">No match for “{q}”. Paste its homepage to add it.</p>}
    </div>}
  </section>;
}

export default async function SuggestionsPage({ searchParams }: { searchParams: Promise<{ view?: string; notice?: string; page?: string; q?: string; error?: string; added?: string; followed?: string; skipped?: string }> }) {
  const user = await requireUser();
  const params = await searchParams;
  const view = params.view === "sources" || params.view === "history" ? params.view : "review";
  const q = (params.q ?? "").slice(0, 200);
  const domain = view === "review" ? domainFromQuery(q) : null;
  const [reviewCount, historyTotal, gateChosen] = await Promise.all([suggestionCount(user.id), view === "history" ? suggestionCount(user.id, true, q) : Promise.resolve(0), hasChosenGate(user.id)]);
  const page = Math.min(pageNumber(params.page), Math.max(1, Math.ceil(historyTotal / 50)));
  const [pending, resolved, matches, sourceCount, settings, active] = await Promise.all([
    view === "review" ? listPendingSuggestions(user.id, 1) : Promise.resolve([]), view === "history" ? listResolvedSuggestions(user.id, 50, page, q) : Promise.resolve([]),
    view === "review" && q.trim() ? searchCatalogue(user.id, domain ?? q) : Promise.resolve([]),
    db().select().from(discoverySources).where(eq(discoverySources.userId, user.id)), getSettings(),
    db().select({ id: tasks.id, type: tasks.type, status: tasks.status }).from(tasks).where(and(
      inArray(tasks.type, ["monitor_source", "extract_document", "verify_company", "suggest_companies"]), inArray(tasks.status, ["queued", "running"]),
      sql`((${tasks.type} = 'suggest_companies' and ${tasks.payload}->>'userId' = ${user.id})
        or exists (select 1 from discovery_sources s where s.user_id = ${user.id} and s.id::text = ${tasks.payload}->>'sourceId')
        or exists (select 1 from discovery_candidates c where c.user_id = ${user.id} and c.id::text = ${tasks.payload}->>'candidateId'))`,
    )),
  ]);
  const now = new Date();
  const similarActive = active.some(t => t.type === "suggest_companies");
  // Surfaced on every view: a source that has stopped working is invisible otherwise, and silence
  // from discovery looks the same as nothing to report.
  const broken = view === "sources" ? [] : notWorkingSources(sourceCount.map(source => ({
    ...source, waiting: 0, suggestionsEnabled: settings.suggestionsEnabled, now,
  })));
  const unverified = needsEmailConfirmation(user);
  // Following starts scanning, so the gate is chosen first; the actions refuse on the same rules.
  const blockedReason = unverified ? VERIFY_SENTENCE : !gateChosen ? CHOOSE_GATE_SENTENCE : null;
  const empty = <>
    <EmptyState title={active.length ? "Discovery is in progress" : "No companies to review"} description={active.length ? "New suggestions appear here as checks finish." : "Add a source to bring in suggestions."}
      action={active.length ? undefined : <a href="/suggestions?view=sources" className={buttonClass("primary", "md", "no-underline")}>Add a source</a>}/>
  </>;
  return <div className="mx-auto max-w-5xl">
    <PageHeader title="Discover companies"/>
    <nav aria-label="Discovery views" className="mb-5 flex flex-wrap gap-2 border-b border-line-muted pb-3">
      {[["review", `Review (${reviewCount})`], ["sources", `Sources (${sourceCount.length})`], ["history", "History"]].map(([key, label]) => <a key={key} href={key === "review" ? "/suggestions" : `/suggestions?view=${key}`} aria-current={view === key ? "page" : undefined} className={`ds-pixel border-2 px-3 py-2 text-11 no-underline ${view === key ? "border-accent bg-accent text-accent-fg" : "border-transparent text-muted hover:bg-sunken hover:text-fg"}`}>{label}</a>)}
    </nav>
    <RefusalNotice sentence={params.error} className="mb-4"/>
    <AddedNotice added={params.added} followed={params.followed} skipped={params.skipped} className="mb-4"/>
    {params.notice && <p role="status" className="mb-4 border border-line-muted p-3 text-14">{params.notice.slice(0, 300)}</p>}
    {broken.length > 0 && <div role="alert" className="mb-4 border-2 border-warn p-3 text-14 text-warn">
      <p><span className="font-semibold">{broken.length === 1 ? "1 source is not being checked" : `${broken.length} sources are not being checked`}:</span> {broken.map(s => s.name).join(", ")}. <a href="/suggestions?view=sources" className="underline">See why</a></p>
    </div>}
        {!settings.suggestionsEnabled && <p role="status" className="mb-4 p-3 text-14 text-warn">Company suggestions are off. <a href="/settings" className="underline">Turn them on in Settings</a></p>}
    {active.length > 0 && <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-2 border border-line-muted p-3 text-14"><span>{active.filter(t => t.status === "running").length} checks running · {active.filter(t => t.status === "queued").length} queued</span><a href={view === "review" ? "/suggestions" : `/suggestions?view=${view}`} className="text-12 text-muted underline hover:text-fg">Refresh</a></div>}
    {view === "sources" ? <DiscoverySources userId={user.id}/> : view === "history" ? <>
      <p className="mb-4 text-14 text-muted">Recently reviewed companies are not suggested again.</p>
      <SearchForm action="/suggestions" className="flex flex-wrap items-end gap-3"><input type="hidden" name="view" value="history"/><label className="grid gap-1.5"><span className={labelClass}>Search history</span><input name="q" defaultValue={q} maxLength={200} className={`h-11 w-80 ${inputClass}`}/></label><Button type="submit" className="h-11">Search</Button><SearchPending /></SearchForm>
      <Pagination page={page} total={historyTotal} path="/suggestions" params={{ view, q }}/>
      {resolved.length ? <div className="space-y-4">{resolved.map(row => <div key={row.suggestion.id}><SuggestionCard row={row}/>{row.suggestion.resolvedAt && <p className="mt-1 text-12 text-muted">{row.suggestion.status === "expired" ? "Expired" : "Reviewed"} {relativeTime(row.suggestion.resolvedAt, now)}</p>}</div>)}</div> : <EmptyState title={q ? "No matching history" : "No review history yet"} description={q ? "Try another name." : "Companies you follow or dismiss appear here."}/>}
    </> : <>
      <CatalogueBox q={q} matches={matches} domain={domain} blockedReason={blockedReason}/>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="ds-pixel text-12">Companies to review</h2>
        {/* Occasional, so a text control rather than a second button beside the deck's own. */}
        <DiscoverySourceForm action={findMoreSuggestions} returnTo="/suggestions" pendingLabel="Queuing search…"><Button variant="ghost" size="sm" type="submit" disabled={!settings.suggestionsEnabled || similarActive}>{similarActive ? "Search queued" : "Find similar companies"}</Button></DiscoverySourceForm>
      </div>
      <SuggestionDeck
        cards={pending.map(row => ({ id: row.suggestion.id, name: row.suggestion.name, body: <SuggestionCardContent row={row}/> }))}
        empty={empty}
        disabledReason={blockedReason ?? undefined}
      />
    </>}
  </div>;
}
