import Link from "next/link";
import { eq } from "drizzle-orm";
import { cvDrafts, applications } from "@christopher/db";
import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { zUuid } from "@/lib/validation";
import { recordApplication } from "@/app/actions/applications";
import { saveCvDraft } from "@/app/actions/cv";
import { PageHeader } from "@/components/PageHeader";
import { SettingsForm } from "@/components/SettingsForm";
import { AutoRefresh } from "@/components/AutoRefresh";
export const dynamic = "force-dynamic";
export default async function CvDraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!zUuid().safeParse(id).success) notFound();
  const [draft] = await db().select().from(cvDrafts).where(eq(cvDrafts.id, id));
  if (!draft) notFound();
  const content = draft.content;
  const [application] = await db().select({ id: applications.id }).from(applications).where(eq(applications.cvId, id)).limit(1);
  return <div className="max-w-4xl space-y-5">
    <PageHeader title={`${draft.companyName} · ${draft.jobTitle}`} description={`CV revision ${draft.revision} · library ${draft.libraryVersion} · ${draft.model}`} />
    <Link href={draft.jobId ? `/cv?job=${draft.jobId}` : "/cv"} className="text-sm underline">Back to CV builder / generate another version</Link>
    {(draft.status === "queued" || draft.status === "generating") && <AutoRefresh />}
    {draft.status === "failed" && <p role="alert" className="rounded bg-red-50 p-4 text-sm text-red-700">{draft.error}</p>}
    {content && <>
      <a href={`/api/cv/${id}/pdf`} className="inline-block rounded bg-slate-900 px-4 py-2 text-sm text-white">Download saved PDF</a>
      <p className="text-sm text-slate-500">Downloads use the saved version. Save your edits first. Check factual accuracy, especially rewritten achievements.</p>
      {content.gaps.length > 0 && <aside className="rounded border border-amber-300 p-4 text-sm"><strong>Evidence gaps (excluded from the PDF)</strong><ul className="mt-2 list-disc pl-5">{content.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul></aside>}
      <SettingsForm action={saveCvDraft.bind(null, id)} submitLabel="Save as new revision">
        <h2 className="text-xl font-semibold">{content.name}</h2><p className="text-sm">{content.contact}</p>{content.linkedinUrl && <a href={content.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-sm underline">LinkedIn</a>}
        <label className="text-sm">Profile<textarea name="summary" defaultValue={content.summary} rows={5} className="mt-1 block w-full rounded border p-2 dark:bg-slate-950" /></label>
        {content.sections.map((section, i) => <label key={section.entryId} className="text-sm"><span className="font-semibold">{section.heading}</span><textarea name={`section-${i}`} defaultValue={section.bullets.join("\n")} rows={Math.max(3, section.bullets.length * 2)} className="mt-1 block w-full rounded border p-2 dark:bg-slate-950" /><span className="text-xs text-slate-500">One bullet per line.</span></label>)}
        <label className="text-sm"><input type="checkbox" name="rememberWording" defaultChecked /> Remember these wording corrections for future CVs. Review or remove them in your evidence library.</label>
      </SettingsForm>
      <section className="rounded border p-4 space-y-3"><h2 className="font-semibold">Application tracking</h2>
        {application ? <Link href="/applications" className="underline">Application recorded — view status and frozen PDF</Link> : <SettingsForm action={recordApplication.bind(null, id)} submitLabel="Record application with this saved CV">
          <p className="text-sm">Use this after submitting this CV revision. This records your application; it does not send anything to the employer.</p>
          <label>Application date<input type="date" name="appliedOn" required className="ml-2 rounded border p-2 dark:bg-slate-950" /></label>
          <label>Notes<textarea name="notes" maxLength={4000} className="block w-full rounded border p-2 dark:bg-slate-950" /></label>
        </SettingsForm>}
      </section>
      <details><summary className="cursor-pointer text-sm">Source evidence and job description used</summary><pre className="mt-2 whitespace-pre-wrap text-xs">{JSON.stringify(draft.librarySnapshot, null, 2)}</pre><p className="mt-4 whitespace-pre-wrap text-xs">{draft.jobDescription}</p></details>
    </>}
  </div>;
}
