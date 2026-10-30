import { Card } from "@/components/Card";
import { inputClass, labelClass } from "@/components/Field";
import { LibraryImportForm } from "@/components/LibraryImportForm";
import { UPLOAD_ACCEPT } from "@/lib/library-upload";
import { importLibraryDocument } from "@/app/actions/library-import";

/**
 * Start a Library from a document that already exists.
 *
 * Three ways in: an uploaded document, pasted text, or the person's own website. LinkedIn's
 * PDF export has a dedicated upload choice, but uses the same import and confirmation pipeline.
 *
 * Each says what is expected of it in one sentence, because the refusals behind them are specific
 * and a person should not have to discover a five-megabyte cap by hitting it.
 */
export function LibraryImportCard({ showTitle = true }: { showTitle?: boolean }) {
  return (
    <Card title={showTitle ? "Import a document" : undefined}>
      <div className="grid gap-5">
        <p className="text-14 text-muted">
          Nothing is added to Experience until you confirm it.
        </p>

        <section id="library-import-cv" className="grid gap-2">
          <h3 className="ds-pixel text-12 text-fg">Upload a CV or career document</h3>
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
        </section>

        <section id="library-import-linkedin" className="grid gap-2 border-t-2 border-line-muted pt-5">
          <h3 className="ds-pixel text-12 text-fg">Import your LinkedIn PDF</h3>
          <ol className="list-decimal space-y-1 pl-5 text-12 text-muted">
            <li>On a desktop, open your own LinkedIn profile.</li>
            <li>Choose More or Resources → Save to PDF.</li>
            <li>Upload that PDF here (up to 5 MB).</li>
          </ol>
          <p className="text-12 text-muted">Save to PDF is unavailable for some members and in the mobile app. If you cannot export a PDF, paste your profile text below instead. A LinkedIn link alone does not read your profile.</p>
          <p className="text-12 text-muted">You can import a CV or other career document alongside a LinkedIn export, one upload at a time. Review the suggested entries before adding them to Experience.</p>
          <a href="https://www.linkedin.com/help/linkedin/answer/a541960" target="_blank" rel="noopener noreferrer" className="w-fit text-12 underline">LinkedIn’s PDF export help</a>
          <LibraryImportForm action={importLibraryDocument} submitLabel="Import LinkedIn PDF" pendingLabel="Uploading…">
            <input type="hidden" name="kind" value="linkedin" />
            <label className={labelClass}>
              LinkedIn PDF
              <input id="library-linkedin-pdf" type="file" name="file" required accept="application/pdf,.pdf" className={`${inputClass} mt-1.5`} />
            </label>
          </LibraryImportForm>
        </section>

        <section className="grid gap-2 border-t-2 border-line-muted pt-5">
          <h3 className="ds-pixel text-12 text-fg">Paste text</h3>
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
        </section>

        <section className="grid gap-2 border-t-2 border-line-muted pt-5">
          <h3 className="ds-pixel text-12 text-fg">Read your website</h3>
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
        </section>
      </div>
    </Card>
  );
}
