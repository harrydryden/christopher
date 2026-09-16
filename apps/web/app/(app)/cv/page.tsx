import { z } from "zod";
import { listCvDraftPages } from "@/lib/queries/cv";
import { desc, eq, and, isNull, sql, ne, ilike, or } from "drizzle-orm";
import { jobs, companies } from "@christopher/db";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { SettingsForm } from "@/components/SettingsForm";
import { requestCv } from "@/app/actions/cv";
import { CvManagement, CvPagination, CvSavedTable } from "@/components/CvSavedTable";
import { buttonClass } from "@/components/Button";
import { inputClass, selectClass } from "@/components/Field";
export const dynamic = "force-dynamic";
export default async function CvPage({ searchParams }: { searchParams: Promise<{ job?: string; q?: string; page?: string; archivedPage?: string }> }) {
  const { job: requestedJob, q: query, page, archivedPage } = await searchParams;
  const job = z.string().uuid().safeParse(requestedJob).success ? requestedJob : undefined;
  const q = (query ?? "").slice(0,200);
  const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const [pages, roles] = await Promise.all([
    listCvDraftPages(page, archivedPage),
    db().select({ id: jobs.id, title: jobs.title, company: companies.name }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(and(eq(jobs.inTable, true), isNull(jobs.archivedAt), ne(companies.status, "archived"), q ? or(ilike(jobs.title, pattern), ilike(companies.name, pattern)) : undefined, sql`not exists (select 1 from decisions d where d.job_id = ${jobs.id} and d.superseded = false and d.decision = 'skip')`)).orderBy(desc(jobs.firstSeenAt), jobs.id).limit(50),
  ]);
  const { saved, archived } = pages;
  if (job && !roles.some(r => r.id === job)) {
    const extra = await db().select({ id: jobs.id, title: jobs.title, company: companies.name }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(eq(jobs.id, job)); roles.unshift(...extra);
  }
  const drafts = saved.rows, archivedDrafts = archived.rows;
  const params = { ...(q ? { q } : {}), ...(job ? { job } : {}) };
  return <div className="max-w-6xl space-y-6">
    <PageHeader title="CV builder" />
    <form method="get" className="flex flex-wrap items-end gap-2"><label className="grid gap-1.5 text-14">Find a role or company<input name="q" defaultValue={q} maxLength={200} className={`min-h-11 w-60 ${inputClass}`}/></label><button type="submit" className={buttonClass("secondary", "sm")}>Search roles</button>{q && <a href="/cv" className="underline">Clear search</a>}</form>
    <Card title="Create a role-specific CV"><SettingsForm action={requestCv} submitLabel="Generate CV">
      <label className="text-14">Role<select name="jobId" defaultValue={job ?? roles[0]?.id} required className={`mt-1 ${selectClass}`}>{roles.map(r => <option key={r.id} value={r.id}>{r.company} · {r.title}</option>)}</select></label>
      {!roles.length && <p className="text-14 text-muted">No matching roles found. Try another search, or add a company and scan its roles.</p>}
      <section><h3 className="ds-label">Job description</h3><textarea name="description" rows={7} maxLength={60000} placeholder="Use the saved description, or paste a replacement." className={`mt-2 resize-y ${inputClass}`} /></section>
    </SettingsForm></Card>
    <CvManagement key={`${saved.page}:${archived.page}`} savedPage={saved.page} archivedPage={archived.page}><Card title="Saved CVs"><CvSavedTable key={`saved-${saved.page}`} rows={drafts} /><CvPagination page={saved.page} total={saved.total} path="/cv" params={{ ...params, archivedPage: String(archived.page) }} label="Saved CV pages" /></Card>
    <Card title="Archived CVs"><CvSavedTable key={`archived-${archived.page}`} rows={archivedDrafts} archived /><CvPagination archived page={archived.page} total={archived.total} path="/cv" params={{ ...params, page: String(saved.page) }} pageParam="archivedPage" label="Archived CV pages" /></Card></CvManagement>
  </div>;
}
