import { headers } from "next/headers";
import { and, asc, desc, eq, sql, inArray } from "drizzle-orm";
import { discoveryDocuments, discoverySources, tasks } from "@ava/db/schema";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { discoverySourceHealth, notWorkingSources, SOURCE_KIND_LABELS } from "@/lib/discovery-ux";
import { importOnlyReason } from "@ava/core";
import { checkDiscoverySource, importDiscoveryDocument, saveDiscoverySource, updateDiscoverySource } from "@/app/actions/discovery-sources";
import { Button } from "./Button";
import { Badge } from "./Badge";
import { DiscoverySourceForm } from "./DiscoverySourceForm";
import { DiscoverySourceFields } from "./DiscoverySourceFields";
import { CopyField } from "./CopyField";
import { subscribeAddressFor } from "@/lib/newsletter-address";
import { inputClass, labelClass } from "@/components/Field";

const input = `min-h-11 ${inputClass}`;
export async function DiscoverySources({ userId }: { userId: string }) {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const origin = `${requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")}://${host}`;
  const [sources, counts, recentTasks, settings] = await Promise.all([
    db().select().from(discoverySources).where(eq(discoverySources.userId, userId)).orderBy(asc(discoverySources.createdAt)),
    db().select({ sourceId: discoveryDocuments.sourceId, count: sql<number>`count(*) filter (where processed_at is null)::int` })
      .from(discoveryDocuments).innerJoin(discoverySources, and(eq(discoverySources.id, discoveryDocuments.sourceId), eq(discoverySources.userId, userId))).groupBy(discoveryDocuments.sourceId),
    db().selectDistinctOn([sql`${tasks.payload}->>'sourceId'`, tasks.status], { payload: tasks.payload, status: tasks.status, result: tasks.result, type: tasks.type }).from(tasks)
      .where(and(inArray(tasks.type, ["monitor_source", "extract_document", "verify_company"]),
        sql`exists (select 1 from discovery_sources s where s.user_id = ${userId} and s.id::text = ${tasks.payload}->>'sourceId')`))
      .orderBy(sql`${tasks.payload}->>'sourceId'`, tasks.status, desc(tasks.createdAt)),
    getSettings(),
  ]);
  const countBySource = new Map(counts.map(c => [c.sourceId, c.count]));
  const date = (value: Date) => value.toLocaleString("en-GB", { timeZone: settings.timezone, dateStyle: "medium", timeStyle: "short" });
  const now = new Date();
  const activeStatusFor = (sourceId: string) => {
    const forSource = recentTasks.filter(t => (t.payload as { sourceId?: string })?.sourceId === sourceId);
    return (forSource.find(t => t.status === "running") ?? forSource.find(t => t.status === "queued"))?.status;
  };
  const broken = notWorkingSources(sources.map(source => ({
    ...source, waiting: countBySource.get(source.id) ?? 0, suggestionsEnabled: settings.suggestionsEnabled,
    activeStatus: activeStatusFor(source.id), now,
  })));
  return <section className="space-y-4" aria-label="Discovery sources">
    {broken.length > 0 && <div role="alert" className="border-2 border-warn p-3 text-14 text-warn">
      <p><span className="font-semibold">{broken.length === 1 ? "1 source is not being checked" : `${broken.length} sources are not being checked`}:</span> {broken.map(s => s.name).join(", ")}. Each card below says why.</p>
    </div>}
    {!recentTasks.some(t => t.status === "queued" || t.status === "running") && <div className="flex justify-end"><a className="text-12 text-muted underline hover:text-fg" href="/suggestions?view=sources">Refresh status</a></div>}
    <section className="border border-line-muted p-4">
      <h3 className="ds-pixel text-12">Add a source</h3>
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
      const health = discoverySourceHealth({ ...source, waiting, suggestionsEnabled: settings.suggestionsEnabled, activeStatus: active?.status, now });
      const { state, importOnly } = health;
      // Nothing to fetch, so a check is only useful once an edition has been imported.
      const canCheck = source.enabled && settings.suggestionsEnabled && !active && (importOnly ? waiting > 0 : true);
      return <article key={source.id} aria-label={source.name} className="space-y-3 border border-line-muted p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0"><h2 className="font-semibold">{source.name}</h2><p className="text-14 text-muted">{SOURCE_KIND_LABELS[source.kind]} · {source.intervalDays === 7 ? "Weekly" : `Every ${source.intervalDays} days`}</p></div>
          <Badge tone={health.tone}>{state}</Badge>
        </div>
        {source.url && <a className="block break-all text-14 text-fg underline" href={source.url} target="_blank" rel="noreferrer">Open source ↗</a>}
        {health.detail && <p className={`text-14 ${health.working ? "text-muted" : "text-warn"}`}>{health.detail}</p>}
        {importOnly && source.kind !== "email" && !source.lastError && <p className="text-14 text-muted">{importOnlyReason(source.url, source.kind)}</p>}
        <p className="text-12 text-muted" title={`Times in ${settings.timezone}`}>{waiting} to check · Last checked {source.lastCheckedAt ? date(source.lastCheckedAt) : "never"}{source.enabled && settings.suggestionsEnabled && !active ? ` · Next ${source.nextRunAt <= new Date() ? "due now" : date(source.nextRunAt)}` : ""}{!active && typeof lastResult?.stored === "number" ? ` · Last run queued ${lastResult.documents ?? 0} pages` : ""}</p>
        {source.lastError && <div role="status" className={`p-3 text-14 ${importOnly ? "text-muted" : "text-warn"}`}><p>{/AI unavailable|budget|extraction failed/i.test(source.lastError) ? <>Company evaluation is unavailable. <a href="/settings" className="underline">Check your budget</a>, then retry.</> : importOnly ? importOnlyReason(source.url, source.kind) : "Some content could not be checked. Import the text below or retry."}</p><section className="mt-1"><h3 className="cursor-pointer">Technical details</h3><p className="mt-1 break-words">{source.lastError}</p></section></div>}
        <DiscoverySourceForm action={checkDiscoverySource.bind(null, source.id)} pendingLabel="Queuing check…"><Button className="min-h-11" size="sm" type="submit" disabled={!canCheck}>{active?.status === "running" ? "Checking…" : active ? "Check queued" : "Check now"}</Button></DiscoverySourceForm>
        <section><h3 className="text-14 font-medium">Import text</h3>
          <p className="my-2 text-12 text-muted">An emailed edition or a post behind sign-in, up to 40,000 characters.</p>
          <DiscoverySourceForm action={importDiscoveryDocument.bind(null, source.id)} pendingLabel="Importing…" className="grid gap-3">
            <label className="grid gap-1.5"><span className={labelClass}>Title or subject</span><input name="title" required maxLength={300} className={input}/></label>
            <label className="grid gap-1.5"><span className={labelClass}>Text</span><textarea name="content" required minLength={100} maxLength={40000} rows={5} className={input}/></label>
            <Button className="min-h-11" type="submit">Import</Button>
          </DiscoverySourceForm>
        </section>
        <section><h3 className="text-14 font-medium">Settings</h3>
          <DiscoverySourceForm action={updateDiscoverySource.bind(null, source.id)} className="mt-3 grid gap-3 sm:flex sm:flex-wrap sm:items-end">
            <label className="grid gap-1.5"><span className={labelClass}>Name</span><input name="name" required maxLength={200} defaultValue={source.name} className={input}/></label>
            {source.kind !== "email" && <label className="grid min-w-0 flex-1 gap-1.5"><span className={labelClass}>URL</span><input name="url" type="url" required maxLength={2048} defaultValue={source.url ?? ""} className={input}/></label>}
            <label className="flex min-h-11 items-center gap-2 text-14"><input type="checkbox" name="enabled" defaultChecked={source.enabled}/> Enabled</label>
            <label className="grid gap-1.5"><span className={labelClass}>Check every (days)</span><input name="intervalDays" type="number" min={1} max={90} required defaultValue={source.intervalDays} className={`${input} max-w-28`}/></label>
            <Button className="min-h-11" size="sm" type="submit">Save</Button>
          </DiscoverySourceForm>
        </section>
        {importOnly && <section><h3 className="text-14 font-medium">Subscribe by email</h3>
          {subscribeAddressFor(source.id)
            ? <div className="mt-3 grid gap-3">
                <p className="text-14 text-muted">Subscribe with this address; each edition is read on the next check.</p>
                <CopyField label="Delivery address" value={subscribeAddressFor(source.id)!} hint="Unique to this source. Anything sent here is filed against it." />
              </div>
            : <div className="mt-3 grid gap-3">
                <p className="text-14 text-muted">Needs inbound email: set <code className="text-13">NEWSLETTER_INGEST_SECRET</code> and <code className="text-13">NEWSLETTER_INBOUND_DOMAIN</code> and point that domain&rsquo;s mail at the endpoint below. Until then, use Import text.</p>
                <CopyField label="Endpoint" value={`${origin}/api/newsletters`} />
                <CopyField label="Source ID" value={source.id} hint="Post JSON with sourceId, title and content, authorised with the ingest secret." />
              </div>}
        </section>}
      </article>;
    })}
  </section>;
}
