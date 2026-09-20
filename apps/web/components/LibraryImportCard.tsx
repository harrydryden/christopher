import { Card } from "@/components/Card";
import { inputClass, labelClass } from "@/components/Field";
import { LibraryImportForm } from "@/components/LibraryImportForm";
import { UPLOAD_ACCEPT } from "@/lib/library-upload";
import { importLibraryDocument } from "@/app/actions/library-import";

/**
 * Start a Library from a document that already exists.
 *
 * Three ways in, in the order people have them to hand: the CV on their computer, the text they
 * can paste from anywhere, and their own page on the web. LinkedIn is named where it is looked
 * for — under the upload, because LinkedIn's own PDF export is an upload — rather than being a
 * fourth box that refuses.
 *
 * Each says what is expected of it in one sentence, because the refusals behind them are specific
 * and a person should not have to discover a five-megabyte cap by hitting it.
 */
export function LibraryImportCard() {
  return (
    <Card title="Import a document">
      <div className="grid gap-5">
        <p className="text-14 text-muted">
          Start from a document you already have. Christopher reads it, proposes what it says, and
          adds nothing to your Library until you have ticked through it.
        </p>

        <section className="grid gap-2">
          <h3 className="ds-pixel text-12 text-fg">Upload a CV</h3>
          <p className="text-12 text-muted">
            A PDF or Word document, up to 5 MB. For LinkedIn, open your profile, choose More → Save
            to PDF, and upload that file: Christopher does not read LinkedIn itself.
          </p>
          <LibraryImportForm action={importLibraryDocument} submitLabel="Import document" pendingLabel="Uploading…">
            <input type="hidden" name="kind" value="cv" />
            <label className={labelClass}>
              Document
              <input type="file" name="file" required accept={UPLOAD_ACCEPT} className={`${inputClass} mt-1.5`} />
            </label>
          </LibraryImportForm>
        </section>

        <section className="grid gap-2 border-t-2 border-line-muted pt-5">
          <h3 className="ds-pixel text-12 text-fg">Paste text</h3>
          <p className="text-12 text-muted">
            The text of your CV or profile, between 100 and 40,000 characters. One document at a time.
          </p>
          <LibraryImportForm action={importLibraryDocument} submitLabel="Import text" pendingLabel="Importing…">
            <input type="hidden" name="kind" value="paste" />
            <label className={labelClass}>
              Your CV or profile
              <textarea name="content" required minLength={100} maxLength={40000} rows={6} className={`${inputClass} mt-1.5 resize-y`} />
            </label>
          </LibraryImportForm>
        </section>

        <section className="grid gap-2 border-t-2 border-line-muted pt-5">
          <h3 className="ds-pixel text-12 text-fg">Read your website</h3>
          <p className="text-12 text-muted">
            The address of a page about you — your own site, or your portfolio. It is fetched as
            politely as any careers page, and job sites are never read.
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
