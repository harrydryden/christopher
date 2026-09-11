import { Pagination, pageNumber } from "@/components/Pagination";
import { and, inArray, sql } from "drizzle-orm";
import { discoverySources, tasks } from "@christopher/db/schema";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { DiscoverySources } from "@/components/DiscoverySources";
import { DiscoverySourceForm } from "@/components/DiscoverySourceForm";
import { acceptSuggestion, findMoreSuggestions, rejectSuggestion } from "@/app/actions/suggestions";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { relativeTime } from "@/lib/format";
import { listPendingSuggestions, listResolvedSuggestions, suggestionCount, type SuggestionRow } from "@/lib/queries/suggestions";

export const dynamic = "force-dynamic";
function SuggestionCard({ row, returnTo = "/suggestions" }: { row: SuggestionRow; returnTo?: string }) {
  const { suggestion, profile, similarToNames } = row;
  const verification = suggestion.verification;
  return <article aria-label={suggestion.name} className="space-y-3 rounded-lg border border-slate-200 p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h2 className="font-semibold"><a href={suggestion.homepageUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">{suggestion.name} ↗</a></h2>
        <p className="text-sm text-slate-500">{profile?.oneLiner ?? suggestion.domain}</p></div>
      <Badge tone={suggestion.status === "accepted" ? "green" : "neutral"}>{suggestion.status === "pending" ? suggestion.evidence ? "From a source" : "Similar employer" : suggestion.status === "accepted" ? "Added" : suggestion.status === "rejected" ? "Dismissed" : "Expired"}</Badge>
    </div>
    {suggestion.rationale && <p className="text-sm text-slate-700">{suggestion.rationale}</p>}
    {similarToNames.length > 0 && <p className="text-sm text-slate-500">Similar to {similarToNames.join(", ")}</p>}
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {typeof verification?.openRoles === "number" && <Badge tone="neutral">{verification.openRoles} roles found</Badge>}
      {typeof verification?.matchingRoles === "number" && <Badge tone="blue">{verification.matchingRoles} filter matches in sample</Badge>}
      {verification?.careersSource && <a href={verification.careersSource.url} target="_blank" rel="noreferrer" className="text-indigo-700 underline">View careers page ↗</a>}
    </div>
    {typeof verification?.matchingRoles === "number" && <p className="text-xs text-slate-500">Matches use a sample of roles, not a complete vacancy count. A company can be worth tracking without a current match.</p>}
    {suggestion.evidence && <section className="rounded bg-slate-50 p-3 text-sm">
      <h3 className="font-medium">Evidence from {suggestion.evidence.sourceName}</h3>
      <div className="mt-2">{suggestion.evidence.url ? <a href={suggestion.evidence.url} target="_blank" rel="noreferrer" className="text-indigo-700 underline">{suggestion.evidence.title} ↗</a> : <p>{suggestion.evidence.title}</p>}
        <blockquote className="mt-2 border-l-2 border-slate-300 pl-3 text-slate-600">“{suggestion.evidence.quote}”</blockquote></div>
    </section>}
    {suggestion.rejectionReason && <p className="text-sm text-slate-500">Your reason: {suggestion.rejectionReason}</p>}
    {suggestion.status === "pending" && <div className="flex flex-wrap items-start gap-3 border-t border-slate-200 pt-3">
      <DiscoverySourceForm action={acceptSuggestion.bind(null, suggestion.id)} returnTo={returnTo} pendingLabel="Adding company…"><Button className="min-h-11" type="submit" variant="primary" size="sm">Add to tracked companies</Button></DiscoverySourceForm>
      <section className="min-w-0 flex-1"><h3 className="py-1 text-sm underline">Dismiss…</h3>
        <DiscoverySourceForm action={rejectSuggestion.bind(null, suggestion.id)} returnTo={returnTo} pendingLabel="Saving decision…" className="mt-2 grid gap-2">
          <label className="grid gap-1 text-sm">Why is this company unsuitable?<textarea name="reason" required maxLength={1000} rows={2} placeholder="e.g. recruitment agency; I prefer product companies" className="w-full rounded border border-slate-300 bg-transparent p-2"/></label>
          <p className="text-xs text-slate-500">Your reason helps inform future recommendations. This company will not be suggested again.</p>
          <Button className="min-h-11" type="submit" size="sm">Dismiss company</Button>
        </DiscoverySourceForm>
      </section>
    </div>}
  </article>;
}

export default async function SuggestionsPage({ searchParams }: { searchParams: Promise<{ view?: string; notice?: string; page?: string; q?: string }> }) {
  const params = await searchParams;
  const view = params.view === "sources" || params.view === "history" ? params.view : "review";
  const q = (params.q ?? "").slice(0, 200);
  const [reviewCount, total] = await Promise.all([suggestionCount(), suggestionCount(view === "history", q)]);
  const page = Math.min(pageNumber(params.page), Math.max(1, Math.ceil(total / 50)));
  const [pending, resolved, sourceCount, settings, active] = await Promise.all([
    view === "review" ? listPendingSuggestions(page, q) : Promise.resolve([]), view === "history" ? listResolvedSuggestions(50, page, q) : Promise.resolve([]),
    db().select({ count: sql<number>`count(*)::int` }).from(discoverySources), getSettings(),
    db().select({ id: tasks.id, type: tasks.type, status: tasks.status }).from(tasks).where(and(inArray(tasks.type, ["monitor_source", "extract_document", "verify_company", "suggest_companies"]), inArray(tasks.status, ["queued", "running"]))),
  ]);
  const now = new Date();
  const similarActive = active.some(t => t.type === "suggest_companies");
  return <div className="mx-auto max-w-5xl">
    <PageHeader title="Discover companies" description="Review relevant employers, see why they were recommended, and choose which to track."/>
    <nav aria-label="Discovery views" className="mb-5 flex flex-wrap gap-2 border-b border-slate-200 pb-3">
      {[["review", `Review (${reviewCount})`], ["sources", `Sources (${sourceCount[0]?.count ?? 0})`], ["history", "History"]].map(([key, label]) => <a key={key} href={key === "review" ? "/suggestions" : `/suggestions?view=${key}`} aria-current={view === key ? "page" : undefined} className={`rounded px-3 py-2 text-sm ${view === key ? "bg-[var(--app-navy)] font-semibold text-white" : "text-slate-600 hover:bg-slate-100"}`}>{label}</a>)}
    </nav>
    {view !== "sources" && <><form method="get" className="flex flex-wrap gap-2"><input type="hidden" name="view" value={view}/><label className="flex min-w-0 flex-wrap items-center gap-2 text-sm">Search recommendations<input name="q" defaultValue={q} maxLength={200} className="min-h-11 rounded border bg-transparent px-3"/></label><Button type="submit">Search</Button></form><Pagination page={page} total={total} path="/suggestions" params={{ view, q }}/></>}
    {params.notice && <p role="status" className="mb-4 rounded border border-slate-200 p-3 text-sm">{params.notice.slice(0, 300)}</p>}
    {!settings.suggestionsEnabled && <p role="status" className="mb-4 rounded bg-amber-50 p-3 text-sm text-amber-900">Discovery is disabled. You can still review recommendations and manage sources. <a href="/settings" className="underline">Enable company suggestions in Settings</a>.</p>}
    {active.length > 0 && <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-3 text-sm"><span>{active.filter(t => t.status === "running").length} checks running · {active.filter(t => t.status === "queued").length} queued. New recommendations will appear in Review.</span><a href={view === "review" ? "/suggestions" : `/suggestions?view=${view}`} className="underline">Refresh progress</a></div>}
    {view === "sources" ? <DiscoverySources/> : view === "history" ? <>
      <h2 className="mb-3 font-semibold">Recently reviewed and expired recommendations</h2>
      <p className="mb-4 text-sm text-slate-500">Browse your review history. Previously suggested companies are not repeated by external sources.</p>
      {resolved.length ? <div className="space-y-4">{resolved.map(row => <div key={row.suggestion.id}><SuggestionCard row={row}/>{row.suggestion.resolvedAt && <p className="mt-1 text-xs text-slate-500">{row.suggestion.status === "expired" ? "Expired" : "Reviewed"} {relativeTime(row.suggestion.resolvedAt, now)}</p>}</div>)}</div> : <EmptyState title="No review history yet" description="Companies you add or dismiss will appear here."/>}
    </> : <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">Companies to review</h2><p className="text-sm text-slate-500">Adding a company starts careers setup and job monitoring. Nothing is added automatically.</p></div>
        <DiscoverySourceForm action={findMoreSuggestions} returnTo="/suggestions" pendingLabel="Queuing search…"><Button className="min-h-11" type="submit" disabled={!settings.suggestionsEnabled || similarActive}>{similarActive ? "Similar-company search queued" : "Find similar companies"}</Button></DiscoverySourceForm>
      </div>
      <p className="mb-4 text-sm text-slate-500">Similar-company searches use employers you already track. To check newsletters and websites, <a href="/suggestions?view=sources" className="underline">manage your sources</a>. <a href="/learning" className="underline">Refine your preference profile</a> to improve relevance.</p>
      {pending.length ? <div className="space-y-4">{pending.map(row => <SuggestionCard key={row.suggestion.id} row={row} returnTo={`/suggestions?${new URLSearchParams({ page: String(page), q })}`}/>)}</div> : <EmptyState title={q ? "No matching recommendations" : active.length ? "Discovery is in progress" : "No companies waiting for review"} description={q ? "Try another company name or clear your search." : active.length ? "Your checks are queued or running. Refresh progress to see new recommendations." : "Add a source or find similar companies to bring in recommendations. If a check finds nothing new, you can refine your preference profile."}/>}
      {!q && !pending.length && !active.length && <div className="mt-3 text-center"><a href="/suggestions?view=sources" className="inline-block rounded bg-[var(--app-navy)] px-4 py-2 text-sm font-semibold text-white">Add a discovery source</a></div>}
    </>}
  </div>;
}
