import Link from "next/link";
import { desc } from "drizzle-orm";
import { applications } from "@christopher/db";
import { db } from "@/lib/db";
import { SettingsForm } from "@/components/SettingsForm";
import { updateApplication } from "@/app/actions/applications";
export const dynamic = "force-dynamic";
export default async function ApplicationsPage() {
  const rows = await db().select({ id: applications.id, cvId: applications.cvId, jobTitle: applications.jobTitle, companyName: applications.companyName, appliedOn: applications.appliedOn, status: applications.status, notes: applications.notes, history: applications.history }).from(applications).orderBy(desc(applications.appliedOn));
  return <div className="max-w-4xl space-y-5"><h1 className="text-2xl font-semibold">Applications</h1><p className="text-sm">Record an application from a saved CV. Its PDF is frozen here; later CV edits do not change it.</p>
    <Link href="/cv" className="underline">Open CV builder</Link>
    {!rows.length && <p>No applications recorded yet.</p>}
    {rows.map(row => <section key={row.id} className="space-y-3 rounded border p-4">
      <h2 className="font-semibold">{row.companyName} · {row.jobTitle}</h2><p className="text-sm">Applied on {row.appliedOn}</p>
      <div className="flex gap-4 text-sm"><a className="underline" href={`/api/applications/${row.id}/pdf`}>Download submitted CV</a><Link className="underline" href={`/cv/${row.cvId}`}>View submitted revision</Link></div>
      <SettingsForm action={updateApplication.bind(null, row.id)} submitLabel="Save application update">
        <label>Status<select name="status" defaultValue={row.status} className="ml-2 rounded border p-2 dark:bg-slate-950">{["applied", "screening", "interview", "offer", "rejected", "withdrawn", "accepted"].map(s => <option key={s}>{s}</option>)}</select></label>
        <label>Notes<textarea name="notes" defaultValue={row.notes} maxLength={4000} className="block w-full rounded border p-2 dark:bg-slate-950" /></label>
      </SettingsForm>
      <details><summary>Status history</summary><ul className="space-y-2 text-sm">{row.history.map((h, i) => <li key={i}>{h.at} · {h.status}{h.notes && ` — ${h.notes}`}</li>)}</ul></details>
    </section>)}
  </div>;
}
