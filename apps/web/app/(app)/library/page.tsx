import { PageHeader } from "@/components/PageHeader";
import Link from "next/link";
import { Card } from "@/components/Card";
import { SettingsForm } from "@/components/SettingsForm";
import { inputClass, labelClass } from "@/components/Field";
import { CvAboutEditor } from "@/components/CvAboutEditor";
import { CareerRecordEditor } from "@/components/CareerRecordEditor";
import { LibraryEvidencePoller } from "@/components/LibraryEvidencePoller";
import { LibraryImportCard } from "@/components/LibraryImportCard";
import { LibrarySecondaryTasks } from "@/components/LibrarySecondaryTasks";
import { LibraryImportPoller } from "@/components/LibraryImportPoller";
import { LibraryImportProposals } from "@/components/LibraryImportProposals";
import { saveCvWritingPreferences } from "@/app/actions/cv";
import { getCvWritingPreferences } from "@/lib/cv-writing-preferences";
import { openStoredLibrary } from "@/lib/cv-library-open";
import { getLibraryEvidence, getOwnCvLibrary, libraryReviewSignature } from "@/lib/queries/cv";
import { libraryImportProgress, listLibraryImports } from "@/lib/queries/library-imports";
import { requireUser } from "@/lib/auth";
import { openEvidenceDrafts } from "@/app/actions/evidence";
import { getCareerWorkspace } from "@/app/actions/career";

export const dynamic = "force-dynamic";

/** A quoted requirement is a note on the visit, not a document: long enough to read, no longer. */
const NEED_LIMIT = 300;

export default async function LibraryPage({ searchParams }: {
  searchParams: Promise<{ view?: string; need?: string; job?: string; return?: string; onboarding?: string; record?: string;
    assertion?: string; query?: string; cursor?: string; assertionsCursor?: string; linksCursor?: string; changesCursor?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const openLinkedIn = params.onboarding === "linkedin";
  const [library, career] = await Promise.all([getOwnCvLibrary(user.id),
    getCareerWorkspace({ recordId: params.record, legacyJobId: params.job, assertionId: params.assertion, query: params.query, cursor: params.cursor,
      assertionsCursor: params.assertionsCursor, linksCursor: params.linksCursor,
      changesCursor: params.changesCursor && /^\d+$/.test(params.changesCursor) ? Number(params.changesCursor) : undefined })]);
  const [evidence, writing, signature, imports, openDrafts] = await Promise.all([
    getLibraryEvidence(user.id, library),
    getCvWritingPreferences(user.id),
    library ? libraryReviewSignature(user.id, library.version) : Promise.resolve(""),
    listLibraryImports(user.id, 10, user.role === "admin"),
    openEvidenceDrafts("library"),
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
  const returnTo = /^\/cv\/[0-9a-f-]{36}(?:\?finding=[^#&]{1,180})?(?:#cv-guided-review)?$/i.test(params.return ?? "") ? params.return! : null;

  // The editor is not keyed on the version: a save revalidates this page, and rebuilding the
  // editor from the server would throw away its unsaved-changes state and the version it is
  // writing over. It takes the stored version as a prop and adopts a newer one only when there is
  // nothing on the screen to lose.
  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader title="Experience" />
      <Link prefetch={false} href="/library/review" className="inline-flex min-h-11 items-center text-13 underline">Review saved details</Link>
      <LibraryImportProposals imports={imports} version={library?.version ?? 0} needsName={!library && !(user.name ?? "").trim()} />
      {importProgress && <LibraryImportPoller pending={reading} signature={importProgress.signature} />}
      <LibrarySecondaryTasks initialTask={params.view === "records" || params.record || params.job || params.assertion ? "records"
        : params.view === "writing" ? "writing" : params.view === "import" || !library || openLinkedIn ? "import" : "records"}
        records={<section id="experience-manual" aria-label="Edit Experience" className="scroll-mt-20"><CareerRecordEditor workspace={career} initialQuery={params.query ?? ""} /></section>}
        importForm={<LibraryImportCard showTitle={!library} openLinkedIn={openLinkedIn} />}
        writingForm={<Card>
          <SettingsForm action={saveCvWritingPreferences} key={JSON.stringify(writing)}
            submitLabel="Save writing preferences" successMessage="Writing preferences saved."
            secondaryActions={<span className="text-12 text-muted">{library ? `Experience version ${library.version}` : "No Experience saved yet"}</span>}>
            <input type="hidden" name="previousPreferences" value={JSON.stringify(writing)} />
            <label className={labelClass}>Writing style<textarea name="stylePreferences" rows={4} maxLength={4000} defaultValue={writing.stylePreferences} className={inputClass} /></label>
            <label className={labelClass}>Saved phrasing<textarea name="preferredWording" rows={5} maxLength={12000} defaultValue={writing.preferredWording} className={inputClass} /></label>
          </SettingsForm>
        </Card>} />
      <section aria-label="About you and contact" className="space-y-3"><CvAboutEditor
        library={content}
        version={library?.version ?? 0}
        evidence={evidence}
        need={(params.need ?? "").slice(0, NEED_LIMIT) || null}
        job={job}
        returnTo={returnTo}
        openDrafts={openDrafts}
        scopeId={user.id}
      /></section>
      {/* While a review is still to land, the page watches for it and refreshes itself. The
          refresh re-renders this server page around the editor, which keeps its unsaved text. */}
      {evidence.evaluating && library && (
        <LibraryEvidencePoller version={library.version} signature={signature} />
      )}
    </div>
  );
}
