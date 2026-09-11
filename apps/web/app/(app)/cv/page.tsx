import Link from "next/link";
import { z } from "zod";
import { Pagination } from "@/components/Pagination";
import { listCvDraftPage } from "@/lib/queries/cv";
import { desc, eq, and, isNull, isNotNull, sql, ne, ilike, or } from "drizzle-orm";
import { cvLibraries, cvDrafts, jobs, companies } from "@christopher/db";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { SettingsForm } from "@/components/SettingsForm";
import { ModelSelect } from "@/components/ModelSelect";
import { requestCv, saveCvModel, setCvArchived } from "@/app/actions/cv";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";
import { buttonClass } from "@/components/Button";
export const dynamic = "force-dynamic";
export default async function CvPage({ searchParams }: { searchParams: Promise<{ job?: string; q?: string; page?: string; archivedPage?: string }> }) {
  const { job: requestedJob, q: query, page, archivedPage } = await searchParams;
  const job = z.string().uuid().safeParse(requestedJob).success ? requestedJob : undefined;
  const q = (query ?? "").slice(0,200);
  const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const [libraries, saved, archived, roles, settings] = await Promise.all([
    db().select({ version: cvLibraries.version }).from(cvLibraries).orderBy(desc(cvLibraries.version)).limit(1),
    listCvDraftPage(false, page),
    listCvDraftPage(true, archivedPage),
    db().select({ id: jobs.id, title: jobs.title, company: companies.name }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(and(eq(jobs.inTable, true), isNull(jobs.archivedAt), ne(companies.status, "archived"), q ? or(ilike(jobs.title, pattern), ilike(companies.name, pattern)) : undefined, sql`not exists (select 1 from decisions d where d.job_id = ${jobs.id} and d.superseded = false and d.decision = 'skip')`)).orderBy(desc(jobs.firstSeenAt), jobs.id).limit(50),
    getSettings(),
  ]);
  if (job && !roles.some(r => r.id === job)) {
    const extra = await db().select({ id: jobs.id, title: jobs.title, company: companies.name }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(eq(jobs.id, job)); roles.unshift(...extra);
  }
  const drafts = saved.rows, archivedDrafts = archived.rows;
  const params = { ...(q ? { q } : {}), ...(job ? { job } : {}) };
  return <div className="max-w-4xl space-y-6">
    <PageHeader title="CV builder" description="Tailor a CV to each role using your own skills, experience and interests." />
    <ol className="flex flex-wrap gap-4 text-sm text-slate-500"><li>1. Choose a role</li><li>2. Generate a draft</li><li>3. Edit and download</li></ol>
    <form method="get" className="flex flex-wrap items-end gap-2"><label className="grid gap-1 text-sm">Find a role or company<input name="q" defaultValue={q} maxLength={200} className="min-h-11 rounded border bg-transparent px-3"/></label><button type="submit" className={buttonClass("secondary", "sm")}>Search roles</button>{q && <a href="/cv" className="underline">Clear search</a>}</form>
    <p className="text-sm text-slate-500">Showing up to 50 recent matching roles. Refine your search, or open the CV builder from a role in your inbox.</p>
    <Card title="Create a role-specific CV"><SettingsForm action={requestCv} submitLabel="Generate CV">
      <label className="text-sm">Role<select name="jobId" defaultValue={job ?? roles[0]?.id} required className="mt-1 block w-full rounded border p-2">{roles.map(r => <option key={r.id} value={r.id}>{r.company} · {r.title}</option>)}</select></label>
      {!roles.length && <p className="text-sm">No matching roles found. Try another search, or add a company and scan its roles.</p>}
      <section><h3 className="text-sm">Paste or override the job description</h3><textarea name="description" rows={7} maxLength={60000} placeholder="Leave blank to use the scraped description." className="mt-2 w-full rounded border p-2 text-sm" /></section>
      <p className="text-xs text-slate-500">Uses library version {libraries[0]?.version ?? "not yet saved"} and {settings.cvModel}. Generation runs in the background. Review each draft before downloading.</p>
    </SettingsForm></Card>
    <Card title="Your evidence library"><p className="text-sm">Saved version: {libraries[0]?.version ?? "none"}. Review and edit your experience, skills and CV preferences in one place.</p><Link href="/cv/library" className="underline">Open evidence library</Link></Card>
    <section><h3 className="text-sm">Advanced model settings</h3><Card title="CV model"><SettingsForm action={saveCvModel}><label className="text-sm">Model<ModelSelect name="cvModel" value={settings.cvModel} className="mt-1 block w-full rounded border p-2" /></label><p className="text-xs text-slate-500">Configured separately from website extraction. Uses the worker’s ANTHROPIC_API_KEY and the monthly AI budget.</p></SettingsForm></Card></section>
    <Card title="Saved CVs"><ul className="space-y-2 text-sm">{drafts.map(d => <li key={d.id} className="flex flex-wrap items-center justify-between gap-2">
      <span><Link className="underline" href={`/cv/${d.id}`}>{d.company} · {d.jobTitle}</Link> — {d.status}, revision {d.revision}</span>
      <form action={setCvArchived.bind(null, d.id, true)}><ConfirmSubmitButton confirmMessage={`Archive the ${d.status} CV for ${d.company} · ${d.jobTitle}? It is hidden from this list but kept, and you can restore it.`}>Archive</ConfirmSubmitButton></form>
    </li>)}</ul>{!drafts.length && <p className="text-sm text-slate-500">No CVs generated yet.</p>}<Pagination page={saved.page} total={saved.total} path="/cv" params={{ ...params, archivedPage: String(archived.page) }} label="Saved CV pages" /></Card>
    {archivedDrafts.length > 0 && <Card title="Archived CVs"><section><h3 className="text-sm text-slate-500">{archivedDrafts.length} archived</h3>
      <ul className="mt-2 space-y-2 text-sm">{archivedDrafts.map(d => <li key={d.id} className="flex flex-wrap items-center justify-between gap-2">
        <span><Link className="underline" href={`/cv/${d.id}`}>{d.company} · {d.jobTitle}</Link> — {d.status}, revision {d.revision}</span>
        <form action={setCvArchived.bind(null, d.id, false)}><button type="submit" className={buttonClass("secondary", "sm")}>Restore</button></form>
      </li>)}</ul>
      <p className="mt-2 text-xs text-slate-500">Archived CVs are kept, not deleted. They stay downloadable by link, and any application recorded against one is unaffected.</p>
    <Pagination page={archived.page} total={archived.total} path="/cv" params={{ ...params, page: String(saved.page) }} pageParam="archivedPage" label="Archived CV pages" /></section></Card>}
  </div>;
}
