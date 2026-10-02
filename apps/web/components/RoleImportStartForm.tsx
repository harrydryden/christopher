"use client";

import { useState } from "react";
import { startRoleImport } from "@/app/actions/role-import";
import { Field, Input } from "@/components/Field";
import { SettingsForm } from "@/components/SettingsForm";

export function RoleImportStartForm() {
  const [kind, setKind] = useState<"link" | "pdf">("link");
  return <SettingsForm action={startRoleImport} submitLabel="Continue to review" resetOnSuccess={false}>
    <fieldset className="space-y-2">
      <legend className="ds-label mb-2">Choose how to add the role</legend>
      <label className="flex min-h-11 cursor-pointer items-center gap-2 border-2 border-line-muted px-3 py-2 text-14">
        <input type="radio" name="kind" value="link" checked={kind === "link"} onChange={() => setKind("link")} />
        Job link
      </label>
      <label className="flex min-h-11 cursor-pointer items-center gap-2 border-2 border-line-muted px-3 py-2 text-14">
        <input type="radio" name="kind" value="pdf" checked={kind === "pdf"} onChange={() => setKind("pdf")} />
        Upload PDF
      </label>
    </fieldset>
    <div hidden={kind !== "link"}>
      <Field label="Job advert link" htmlFor="role-import-url" hint="Paste the web address of one job advert.">
        <Input id="role-import-url" name="url" type="url" autoComplete="url" placeholder="https://example.com/jobs/…" required={kind === "link"} disabled={kind !== "link"} />
      </Field>
    </div>
    <div hidden={kind !== "pdf"}>
      <Field label="Job description PDF" htmlFor="role-import-file" hint="Choose a PDF with selectable text, up to 5 MB. You can check and edit what we extract before saving.">
        <Input id="role-import-file" name="file" type="file" accept="application/pdf,.pdf" required={kind === "pdf"} disabled={kind !== "pdf"} />
      </Field>
    </div>
    <p className="text-13 text-muted">We’ll extract the role details for you to check. No CV work starts until you save the role and choose Build CV.</p>
  </SettingsForm>;
}
