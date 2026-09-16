import { PageHeader } from "@/components/PageHeader";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { applications } from "@christopher/db";
import { db } from "@/lib/db";
import { SettingsForm } from "@/components/SettingsForm";
import { inputClass, labelClass, selectClass } from "@/components/Field";
import { updateApplication } from "@/app/actions/applications";
import { requireUser } from "@/lib/auth";
export const dynamic = "force-dynamic";
export default async function ApplicationsPage() {
  const user = await requireUser();
  const rows = await db().select({ id: applications.id, cvId: applications.cvId, jobTitle: applications.jobTitle, companyName: applications.companyName, appliedOn: applications.appliedOn, status: applications.status, notes: applications.notes, history: applications.history })
    .from(applications).where(eq(applications.userId, user.id)).orderBy(desc(applications.appliedOn));
  return <div className="max-w-4xl space-y-5"><PageHeader title="Applications" />
    <Link href="/cv" className="underline">Open CV builder</Link>
    {!rows.length && <p>No applications recorded yet.</p>}
    {rows.map(row => <section key={row.id} className="space-y-3 border-2 border-line bg-raised p-4">
      <h2 className="ds-pixel text-12">{row.companyName} · {row.jobTitle}</h2><p className="text-14 text-muted">Applied on {row.appliedOn}</p>
      <div className="flex gap-4 text-14"><a className="underline" href={`/api/applications/${row.id}/pdf`}>Download submitted CV</a>{row.cvId && <Link className="underline" href={`/cv/${row.cvId}`}>View submitted revision</Link>}</div>
      <SettingsForm action={updateApplication.bind(null, row.id)} submitLabel="Save application update">
        <label className="grid gap-1.5"><span className={labelClass}>Status</span><select name="status" defaultValue={row.status} className={selectClass}>{["applied", "screening", "interview", "offer", "rejected", "withdrawn", "accepted"].map(s => <option key={s}>{s}</option>)}</select></label>
        <label className="grid gap-1.5"><span className={labelClass}>Notes</span><textarea name="notes" defaultValue={row.notes} maxLength={4000} rows={3} className={`resize-y ${inputClass}`} /></label>
      </SettingsForm>
      <section><h3 className="ds-label">Status history</h3><ul className="mt-1 space-y-2 text-14">{row.history.map((h, i) => <li key={i}>{h.at} · {h.status}{h.notes && ` — ${h.notes}`}</li>)}</ul></section>
    </section>)}
  </div>;
}
