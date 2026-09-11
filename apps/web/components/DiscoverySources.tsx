import { asc, desc, eq, sql, inArray } from "drizzle-orm";
import { discoveryDocuments, discoverySources, tasks } from "@christopher/db/schema";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { discoverySourceState, SOURCE_KIND_LABELS } from "@/lib/discovery-ux";
import { checkDiscoverySource, importDiscoveryDocument, saveDiscoverySource, updateDiscoverySource } from "@/app/actions/discovery-sources";
import { Button } from "./Button";
import { Badge } from "./Badge";
import { DiscoverySourceForm } from "./DiscoverySourceForm";
import { DiscoverySourceFields } from "./DiscoverySourceFields";

const input = "min-h-11 w-full rounded border border-slate-300 bg-transparent p-2 text-sm";
export async function DiscoverySources() {
  const [sources, counts, recentTasks, settings] = await Promise.all([
    db().select().from(discoverySources).orderBy(asc(discoverySources.createdAt)),
    db().select({ sourceId: discoveryDocuments.sourceId, count: sql<number>`count(*) filter (where processed_at is null)::int` })
      .from(discoveryDocuments).groupBy(discoveryDocuments.sourceId),
    db().selectDistinctOn([sql`${tasks.payload}->>'sourceId'`, tasks.status], { payload: tasks.payload, status: tasks.status, result: tasks.result, type: tasks.type }).from(tasks)
      .where(inArray(tasks.type, ["monitor_source", "extract_document", "verify_company"]))
      .orderBy(sql`${tasks.payload}->>'sourceId'`, tasks.status, desc(tasks.createdAt)),
    getSettings(),
  ]);
  const countBySource = new Map(counts.map(c => [c.sourceId, c.count]));
  const date = (value: Date) => value.toLocaleString("en-GB", { timeZone: settings.timezone, dateStyle: "medium", timeStyle: "short" });
  return <section className="space-y-4" aria-label="Discovery sources">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-slate-500">Sources bring new companies into Review. Previously reviewed companies are not recommended again.</p>
      {!recentTasks.some(t => t.status === "queued" || t.status === "running") && <a className="text-sm underline" href="/suggestions?view=sources">Refresh status</a>}
    </div>
    <section className="rounded-lg border border-slate-200 p-4">
      <h3 className="font-semibold">Add a source</h3>
      <DiscoverySourceForm action={saveDiscoverySource} className="mt-4 grid max-w-xl gap-4">
        <DiscoverySourceFields/>
        <Button className="min-h-11" type="submit" variant="primary">Add source</Button>
      </DiscoverySourceForm>
    </section>
    {sources.map(source => {
      const waiting = countBySource.get(source.id) ?? 0;
      const sourceTasks = recentTasks.filter(t => (t.payload as { sourceId?: string })?.sourceId === source.id);
      const active = sourceTasks.find(t => t.status === "running") ?? sourceTasks.find(t => t.status === "queued");
      const lastResult = sourceTasks.find(t => t.status === "done" && t.type === "monitor_source")?.result as { stored?: number; documents?: number; skipped?: string } | undefined;
      const state = discoverySourceState({ ...source, waiting, suggestionsEnabled: settings.suggestionsEnabled, activeStatus: active?.status });
      const canCheck = source.enabled && settings.suggestionsEnabled && !active && (source.kind !== "email" || waiting > 0);
      return <article key={source.id} aria-label={source.name} className="space-y-3 rounded-lg border border-slate-200 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0"><h2 className="font-semibold">{source.name}</h2><p className="text-sm text-slate-500">{SOURCE_KIND_LABELS[source.kind]} · {source.intervalDays === 7 ? "Weekly" : `Every ${source.intervalDays} days`}</p></div>
          <Badge tone={state === "Needs attention" ? "amber" : active ? "blue" : "neutral"}>{state}</Badge>
        </div>
        {source.url && <a className="block break-all text-sm text-accent underline" href={source.url} target="_blank" rel="noreferrer">Open source ↗</a>}
        <p className="text-sm">{waiting} {waiting === 1 ? "edition or page" : "editions or pages"} waiting to be checked</p>
        <p className="text-xs text-slate-500">Last checked: {source.lastCheckedAt ? date(source.lastCheckedAt) : "Not yet"}. {source.enabled && settings.suggestionsEnabled && !active ? `Next: ${source.nextRunAt <= new Date() ? "due now" : date(source.nextRunAt)}.` : ""} Times shown in {settings.timezone}.</p>
        {!active && typeof lastResult?.stored === "number" && <p className="text-sm text-slate-500">Last collection: {lastResult.documents ?? 0} new or changed pages queued for evaluation. Verified companies appear in Review.</p>}
        {source.lastError && <div role="status" className="rounded bg-amber-50 p-3 text-sm text-amber-900"><p>{/AI unavailable|budget|extraction failed/i.test(source.lastError) ? <>Company evaluation is unavailable. <a href="/settings" className="underline">Check your AI settings and budget</a>, then try again.</> : "Some content could not be checked. You can import the text below or try again."}</p><section className="mt-1"><h3 className="cursor-pointer">Technical details</h3><p className="mt-1 break-words">{source.lastError}</p></section></div>}
        <DiscoverySourceForm action={checkDiscoverySource.bind(null, source.id)} pendingLabel="Queuing check…"><Button className="min-h-11" size="sm" type="submit" disabled={!canCheck}>{active?.status === "running" ? "Checking…" : active ? "Check queued" : "Check now"}</Button></DiscoverySourceForm>
        {source.kind === "email" && waiting === 0 && <p className="text-sm text-slate-500">Import an edition below to make content available for checking.</p>}
        <section><h3 className="text-sm font-medium">Import text</h3>
          <p className="my-2 text-sm text-slate-500">Paste an emailed edition or a post that requires sign-in. Up to 40,000 characters per import. Duplicate imports are ignored.</p>
          <DiscoverySourceForm action={importDiscoveryDocument.bind(null, source.id)} pendingLabel="Importing…" className="grid gap-3">
            <label className="grid gap-1 text-sm">Edition title or email subject<input name="title" required maxLength={300} className={input}/></label>
            <label className="grid gap-1 text-sm">Newsletter or post text<textarea name="content" required minLength={100} maxLength={40000} rows={5} className={input}/></label>
            <Button className="min-h-11" type="submit">Import edition</Button>
          </DiscoverySourceForm>
        </section>
        <section><h3 className="text-sm font-medium">Source settings</h3>
          <DiscoverySourceForm action={updateDiscoverySource.bind(null, source.id)} className="mt-3 grid gap-3 sm:flex sm:flex-wrap sm:items-end">
            <label className="grid gap-1 text-sm">Source name<input name="name" required maxLength={200} defaultValue={source.name} className={input}/></label>
            {source.kind !== "email" && <label className="grid min-w-0 flex-1 gap-1 text-sm">Source URL<input name="url" type="url" required maxLength={2048} defaultValue={source.url ?? ""} className={input}/></label>}
            <label className="text-sm"><input type="checkbox" name="enabled" defaultChecked={source.enabled}/> Keep this source enabled</label>
            <label className="grid gap-1 text-sm">Check every (days)<input name="intervalDays" type="number" min={1} max={90} required defaultValue={source.intervalDays} className={`${input} max-w-28`}/></label>
            <Button className="min-h-11" size="sm" type="submit">Save settings</Button>
          </DiscoverySourceForm>
          <p className="mt-2 text-xs text-slate-500">Pausing preserves imported content and recommendations. A check already running may finish.</p>
        </section>
        {source.kind === "email" && <section><h3 className="text-sm">Automatic email delivery — advanced setup</h3><p className="mt-2 text-sm text-slate-500">Ask your administrator to connect an email forwarding service to the authenticated newsletter endpoint. Until then, use Import text.</p><p className="mt-2 break-all text-xs text-slate-500">Source ID: {source.id}</p></section>}
      </article>;
    })}
  </section>;
}
