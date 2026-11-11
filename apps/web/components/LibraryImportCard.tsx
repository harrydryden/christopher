"use client";

import { useState } from "react";
import { Card } from "@/components/Card";
import { inputClass, labelClass } from "@/components/Field";
import { LibraryImportForm } from "@/components/LibraryImportForm";
import { UPLOAD_ACCEPT } from "@/lib/library-upload";
import { importLibraryDocument } from "@/app/actions/library-import";
import { TaskNavigation } from "./TaskNavigation";

/**
 * Start a Library from a document that already exists.
 *
 * Three ways in: an uploaded document, pasted text, or the person's own website. LinkedIn's
 * PDF export has a dedicated upload choice, but uses the same import and confirmation pipeline.
 *
 * Each says what is expected of it in one sentence, because the refusals behind them are specific
 * and a person should not have to discover a five-megabyte cap by hitting it.
 */
export function LibraryImportCard({ showTitle = true, openLinkedIn = false }: { showTitle?: boolean; openLinkedIn?: boolean }) {
  const [source, setSource] = useState<"cv" | "linkedin" | "paste" | "website">(openLinkedIn ? "linkedin" : "cv");
  const choices = [
    { id: "cv", label: "CV or career document", panelId: "library-import-cv" },
    { id: "linkedin", label: "LinkedIn PDF export", panelId: "library-import-linkedin" },
    { id: "paste", label: "Pasted text", panelId: "library-import-paste" },
    { id: "website", label: "Your website or portfolio", panelId: "library-import-website" },
  ] as const;
  return (
    <Card title={showTitle ? "Start from a document or page" : undefined}>
      <div className="grid gap-2">
        <TaskNavigation label="Import source" idPrefix="library-import-source" items={choices} active={source} onSelect={setSource} />

        <section id="library-import-cv" role="tabpanel" aria-labelledby="library-import-source-tab-cv" hidden={source !== "cv"} className="border-t border-line-muted pt-2">
          <h3 className="text-14 font-medium">CV or career document</h3>
          <div className="grid gap-2 pb-4">
          <p className="text-12 text-muted">
            PDF or Word, up to 5 MB.
          </p>
          <LibraryImportForm action={importLibraryDocument} submitLabel="Import document" pendingLabel="Uploading…">
            <input type="hidden" name="kind" value="cv" />
            <label className={labelClass}>
              Document
              <input type="file" name="file" required accept={UPLOAD_ACCEPT} className={`${inputClass} mt-1.5`} />
            </label>
          </LibraryImportForm>
          </div>
        </section>

        <section id="library-import-linkedin" role="tabpanel" aria-labelledby="library-import-source-tab-linkedin" hidden={source !== "linkedin"} className="border-t border-line-muted pt-2">
          <h3 className="text-14 font-medium">LinkedIn PDF export</h3>
          <div className="grid gap-2 pb-4">
          <p className="text-13 text-muted">Upload only your own profile. This is a dated export, not a check of your live LinkedIn page.</p>
          <ol className="list-decimal space-y-1 pl-5 text-12 text-muted">
            <li>On a desktop, open your own LinkedIn profile.</li>
            <li>Choose More or Resources → Save to PDF.</li>
            <li>Upload that PDF here (up to 5 MB).</li>
          </ol>
          <p className="text-12 text-muted">Save to PDF is unavailable for some members and in the mobile app. If you cannot export a PDF, paste text from your own profile below instead. A LinkedIn link alone does not read your profile.</p>
          <a href="https://www.linkedin.com/help/linkedin/answer/a541960" target="_blank" rel="noopener noreferrer" className="w-fit text-12 underline">LinkedIn’s PDF export help</a>
          <LibraryImportForm action={importLibraryDocument} submitLabel="Import LinkedIn PDF" pendingLabel="Uploading…">
            <input type="hidden" name="kind" value="linkedin" />
            <label className={labelClass}>
              LinkedIn PDF
              <input id="library-linkedin-pdf" type="file" name="file" required accept="application/pdf,.pdf" className={`${inputClass} mt-1.5`} />
            </label>
            <label className="flex min-h-11 items-center gap-2 text-13"><input type="checkbox" name="ownProfile" value="yes" required />
              This is an export of my own LinkedIn profile.</label>
          </LibraryImportForm>
          </div>
        </section>

        <section id="library-import-paste" role="tabpanel" aria-labelledby="library-import-source-tab-paste" hidden={source !== "paste"} className="border-t border-line-muted pt-2">
          <h3 className="text-14 font-medium">Pasted text</h3>
          <div className="grid gap-2 pb-4">
          <p className="text-12 text-muted">
            100 to 40,000 characters, one document at a time.
          </p>
          <LibraryImportForm action={importLibraryDocument} submitLabel="Import text" pendingLabel="Importing…">
            <input type="hidden" name="kind" value="paste" />
            <label className={labelClass}>
              Text
              <textarea name="content" required minLength={100} maxLength={40000} rows={6} className={`${inputClass} mt-1.5 resize-y`} />
            </label>
          </LibraryImportForm>
          </div>
        </section>

        <section id="library-import-website" role="tabpanel" aria-labelledby="library-import-source-tab-website" hidden={source !== "website"} className="border-t border-line-muted pt-2">
          <h3 className="text-14 font-medium">Your website or portfolio</h3>
          <div className="grid gap-2 pb-4">
          <p className="text-12 text-muted">
            Your own site or portfolio. Job sites are never read.
          </p>
          <LibraryImportForm action={importLibraryDocument} submitLabel="Read page" pendingLabel="Queuing…">
            <input type="hidden" name="kind" value="website" />
            <label className={labelClass}>
              Page address
              <input type="url" name="url" required maxLength={2048} placeholder="https://" className={`${inputClass} mt-1.5`} />
            </label>
          </LibraryImportForm>
          </div>
        </section>
      </div>
    </Card>
  );
}
