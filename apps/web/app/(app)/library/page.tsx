import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { SettingsForm } from "@/components/SettingsForm";
import { inputClass, labelClass } from "@/components/Field";
import { CvLibraryEditor } from "@/components/CvLibraryEditor";
import { LibraryEvidencePoller } from "@/components/LibraryEvidencePoller";
import { LibraryImportCard } from "@/components/LibraryImportCard";
import { LibraryImportPoller } from "@/components/LibraryImportPoller";
import { LibraryImportProposals } from "@/components/LibraryImportProposals";
import { saveCvWritingPreferences } from "@/app/actions/cv";
import { getCvWritingPreferences } from "@/lib/cv-writing-preferences";
import { openStoredLibrary } from "@/lib/cv-library-open";
import { getLibraryEvidence, getOwnCvLibrary, libraryReviewSignature } from "@/lib/queries/cv";
import { libraryImportProgress, listLibraryImports } from "@/lib/queries/library-imports";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** A quoted requirement is a note on the visit, not a document: long enough to read, no longer. */
const NEED_LIMIT = 300;

export default async function LibraryPage({ searchParams }: {
  searchParams: Promise<{ need?: string; job?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const library = await getOwnCvLibrary(user.id);
  const [evidence, writing, signature, imports] = await Promise.all([
    getLibraryEvidence(user.id, library),
    getCvWritingPreferences(user.id),
    library ? libraryReviewSignature(user.id, library.version) : Promise.resolve(""),
    listLibraryImports(user.id),
  ]);
  // Documents still being read. The page watches for them below, and stops watching when the
  // refresh that lands the last proposal re-renders this without any.
  const reading = imports.filter(item => item.state === "reading").length;
  // The fingerprint the poller compares against, read only while there is something to watch.
  const importProgress = reading > 0 ? await libraryImportProgress(user.id) : null;

  // What the editor opens: the stored content, upgraded from whatever release wrote it. A library
  // saved before a row could carry several types, with a block stored as a draft, or with its
  // contact details on one line, opens in today's shape rather than in the one it was written in.
  const content = library ? openStoredLibrary(library.content) : null;

  // The employment record a CV's evidence gap was about, if the link named one this account has.
  const job = (content?.employment ?? []).some(item => item.id === params.job) ? params.job ?? null : null;

  // The editor is not keyed on the version: a save revalidates this page, and rebuilding the
  // editor from the server would throw away its unsaved-changes state and the version it is
  // writing over. It takes the stored version as a prop and adopts a newer one only when there is
  // nothing on the screen to lose.
  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader title="Library" />
      <LibraryImportProposals imports={imports} version={library?.version ?? 0} />
      {importProgress && <LibraryImportPoller pending={reading} signature={importProgress.signature} />}
      <CvLibraryEditor
        library={content}
        version={library?.version ?? 0}
        evidence={evidence}
        need={(params.need ?? "").slice(0, NEED_LIMIT) || null}
        job={job}
      />
      {/* While a review is still to land, the page watches for it and refreshes itself. The
          refresh re-renders this server page around the editor, which keeps its unsaved text. */}
      {evidence.evaluating && library && (
        <LibraryEvidencePoller version={library.version} signature={signature} />
      )}
      <LibraryImportCard />
      <Card title="Writing preferences">
        <SettingsForm
          action={saveCvWritingPreferences}
          key={JSON.stringify(writing)}
          secondaryActions={<span className="text-12 text-muted">{library ? `Library version ${library.version}` : "No library saved yet"}</span>}
        >
          <input type="hidden" name="previousPreferences" value={JSON.stringify(writing)} />
          <label className={labelClass}>Writing style<textarea name="stylePreferences" rows={4} maxLength={4000} defaultValue={writing.stylePreferences} className={inputClass} /></label>
          <label className={labelClass}>Saved phrasing<textarea name="preferredWording" rows={5} maxLength={12000} defaultValue={writing.preferredWording} className={inputClass} /></label>
        </SettingsForm>
      </Card>
    </div>
  );
}
