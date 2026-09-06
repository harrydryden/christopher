import Link from "next/link";
import { desc, eq, and, isNull } from "drizzle-orm";
import { cvLibraries, cvDrafts, jobs, companies } from "@christopher/db";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { SettingsForm } from "@/components/SettingsForm";
import { CvLibraryEditor } from "@/components/CvLibraryEditor";
import { requestCv, saveCvModel } from "@/app/actions/cv";
export const dynamic = "force-dynamic";
export default async function CvPage({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  const { job } = await searchParams;
  const [libraries, drafts, roles, settings] = await Promise.all([
    db().select().from(cvLibraries).orderBy(desc(cvLibraries.version)).limit(1),
    db().select({ id: cvDrafts.id, jobTitle: cvDrafts.jobTitle, company: cvDrafts.companyName, status: cvDrafts.status, revision: cvDrafts.revision }).from(cvDrafts).orderBy(desc(cvDrafts.createdAt)).limit(50),
    db().select({ id: jobs.id, title: jobs.title, company: companies.name }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(and(eq(jobs.inTable, true), isNull(jobs.archivedAt))).orderBy(companies.name, jobs.title),
    getSettings(),
  ]);
  if (job && !roles.some(r => r.id === job) && /^[0-9a-f-]{36}$/i.test(job)) {
    const extra = await db().select({ id: jobs.id, title: jobs.title, company: companies.name }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(eq(jobs.id, job)); roles.unshift(...extra);
  }
  return <div className="max-w-4xl space-y-6">
    <PageHeader title="CV builder" description="Tailor a CV to each role using your own skills, experience and interests." />
    <Card title="Create a role-specific CV"><SettingsForm action={requestCv} submitLabel="Generate CV">
      <label className="text-sm">Role<select name="jobId" defaultValue={job ?? roles[0]?.id} required className="mt-1 block w-full rounded border p-2 dark:bg-slate-950">{roles.map(r => <option key={r.id} value={r.id}>{r.company} · {r.title}</option>)}</select></label>
      {!roles.length && <p className="text-sm">Add a company and scan its roles first.</p>}
      <details><summary className="cursor-pointer text-sm">Paste or override the job description</summary><textarea name="description" rows={7} maxLength={60000} placeholder="Leave blank to use the scraped description." className="mt-2 w-full rounded border p-2 text-sm dark:bg-slate-950" /></details>
      <p className="text-xs text-slate-500">Uses library version {libraries[0]?.version ?? "not yet saved"} and {settings.cvModel}. Generation runs in the background. Review each draft before downloading.</p>
    </SettingsForm></Card>
    <Card title="Your evidence library"><Link href="/cv/library" className="underline">Open full evidence library and CV preferences</Link><CvLibraryEditor key={libraries[0]?.version ?? 0} library={libraries[0]?.content ?? null} version={libraries[0]?.version ?? 0} /></Card>
    <Card title="CV model"><SettingsForm action={saveCvModel}><label className="text-sm">Anthropic model ID<input name="cvModel" defaultValue={settings.cvModel} className="mt-1 block w-full rounded border p-2 dark:bg-slate-950" /></label><p className="text-xs text-slate-500">Configured separately from website extraction. Uses the worker’s ANTHROPIC_API_KEY and the monthly AI budget.</p></SettingsForm></Card>
    <Card title="Saved CVs"><ul className="space-y-2 text-sm">{drafts.map(d => <li key={d.id}><Link className="underline" href={`/cv/${d.id}`}>{d.company} · {d.jobTitle}</Link> — {d.status}, revision {d.revision}</li>)}</ul>{!drafts.length && <p className="text-sm text-slate-500">No CVs generated yet.</p>}</Card>
  </div>;
}
