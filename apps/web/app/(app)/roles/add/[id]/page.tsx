import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { Field, Input, Textarea } from "@/components/Field";
import { SettingsForm } from "@/components/SettingsForm";
import { RoleImportPoll } from "@/components/RoleImportPoll";
import { retryRoleImport, saveImportedRole } from "@/app/actions/role-import";
import { requireUser } from "@/lib/auth";
import { getRoleImport } from "@/lib/queries/role-imports";

export const dynamic = "force-dynamic";

export default async function ReviewImportedRolePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const user = await requireUser();
  const row = await getRoleImport(user.id, id);
  if (!row) notFound();
  const from = row.kind === "pdf" ? row.filename || "Uploaded PDF" : row.url || "Job link";
  return <div className="max-w-3xl">
    <PageHeader title="Review role" description="Check the extracted details before adding this role to Shortlisted." />
    <Link prefetch={false} href="/" className="mb-5 inline-flex min-h-11 items-center text-13 underline">← Back to Roles</Link>
    <p className="mb-4 break-all text-13 text-muted">Source: {from}</p>
    {row.status === "queued" && <Card title="Import in progress"><RoleImportPoll /></Card>}
    {row.status === "failed" && <Card title="Could not extract this role">
      <p role="alert" className="mb-3 text-14 text-danger">{row.error || "The import failed. You can try again."}</p>
      <SettingsForm action={retryRoleImport.bind(null, id)} submitLabel="Retry import" resetOnSuccess={false} />
      <details className="mt-5 border-t-2 border-line-muted pt-4">
        <summary className="min-h-11 cursor-pointer font-semibold underline">Paste the job description instead</summary>
        <p className="my-3 text-13 text-muted">You can enter the details yourself if extraction keeps failing. Check them before saving to Shortlisted.</p>
        <SettingsForm action={saveImportedRole.bind(null, id)} submitLabel="Save to Shortlisted" resetOnSuccess={false}>
          <input type="hidden" name="manualRecovery" value="1" />
          <Field label="Job title" htmlFor="recovery-title"><Input id="recovery-title" name="title" defaultValue={row.title || ""} required maxLength={300} /></Field>
          <Field label="Company name" htmlFor="recovery-company"><Input id="recovery-company" name="companyName" defaultValue={row.companyName || ""} required maxLength={300} /></Field>
          <Field label="Location" htmlFor="recovery-location" hint="Leave blank if the advert does not give a location."><Input id="recovery-location" name="location" defaultValue={row.location || ""} maxLength={300} /></Field>
          <Field label="Job description" htmlFor="recovery-description"><Textarea id="recovery-description" name="description" defaultValue={row.descriptionText || ""} rows={14} minLength={80} maxLength={60000} required /></Field>
        </SettingsForm>
      </details>
      <p className="mt-3 text-13 text-muted">You can also <Link prefetch={false} href="/roles/add" className="underline">add a different link or PDF</Link>.</p>
    </Card>}
    {row.status === "ready" && <Card title="Confirm role details">
      {row.truncated && <p role="status" className="mb-4 border-2 border-warn px-3 py-2 text-13 text-warn">The source was too long to extract in full. Check the description below and add any missing details before saving.</p>}
      <SettingsForm action={saveImportedRole.bind(null, id)} submitLabel="Save to Shortlisted" resetOnSuccess={false}>
        <Field label="Job title" htmlFor="import-title"><Input id="import-title" name="title" defaultValue={row.title || ""} required maxLength={300} /></Field>
        <Field label="Company name" htmlFor="import-company"><Input id="import-company" name="companyName" defaultValue={row.companyName || ""} required maxLength={300} /></Field>
        <Field label="Location" htmlFor="import-location" hint="Leave blank if the advert does not give a location."><Input id="import-location" name="location" defaultValue={row.location || ""} maxLength={300} /></Field>
        <Field label="Job description" htmlFor="import-description" hint="This text is used to tailor your CV. Review it carefully, especially if extraction was incomplete."><Textarea id="import-description" name="description" defaultValue={row.descriptionText || ""} rows={14} minLength={80} maxLength={60000} required /></Field>
        {row.truncated && <label className="flex items-start gap-2 text-13 text-fg">
          <input type="checkbox" name="fullDescriptionConfirmed" value="1" required className="mt-1 h-4 w-4 shrink-0" />
          <span>I have checked the full advert and supplied or confirmed the complete description for this CV.</span>
        </label>}
        <p className="text-13 text-muted">After saving, open the role and choose Build CV. You’ll answer the usual tailoring questions before the CV is generated.</p>
      </SettingsForm>
    </Card>}
    {row.status === "saved" && <Card title="Role saved">
      <p className="mb-3 text-14">This role has been saved. Open it to review its current status or build a CV.</p>
      <Link prefetch={false} href={row.jobId ? `/roles/${row.jobId}` : "/?view=user-shortlisted#roles"} className="underline">Open saved role</Link>
    </Card>}
  </div>;
}
