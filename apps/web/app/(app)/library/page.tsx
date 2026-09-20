import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { SettingsForm } from "@/components/SettingsForm";
import { inputClass, labelClass } from "@/components/Field";
import { CvLibraryEditor } from "@/components/CvLibraryEditor";
import { LibraryEvidencePoller } from "@/components/LibraryEvidencePoller";
import { LibraryImportCard } from "@/components/LibraryImportCard";
import { LibraryImportPoller } from "@/components/LibraryImportPoller";
import { LibraryImportProposals } from "@/components/LibraryImportProposals";
import { LibraryVersions } from "@/components/LibraryVersions";
import { saveCvWritingPreferences } from "@/app/actions/cv";
import { getCvWritingPreferences } from "@/lib/cv-writing-preferences";
import { diffCvLibraries, requestedDiff } from "@/lib/cv-library-diff";
import {
  getLibraryEvidence,
  getLibraryVersionContents,
  getOwnCvLibrary,
  libraryReviewSignature,
  listLibraryVersions,
} from "@/lib/queries/cv";
import { listLibraryImports } from "@/lib/queries/library-imports";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** A quoted requirement is a note on the visit, not a document: long enough to read, no longer. */
const NEED_LIMIT = 300;

export default async function LibraryPage({ searchParams }: {
  searchParams: Promise<{ need?: string; job?: string; diff?: string; a?: string; b?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const library = await getOwnCvLibrary(user.id);
  const [evidence, versions, writing, signature, imports] = await Promise.all([
    getLibraryEvidence(user.id, library),
    listLibraryVersions(user.id),
    getCvWritingPreferences(user.id),
    library ? libraryReviewSignature(user.id, library.version) : Promise.resolve(""),
    listLibraryImports(user.id),
  ]);
  // Documents still being read. The page watches for them below, and stops watching when the
  // refresh that lands the last proposal re-renders this without any.
  const reading = imports.filter(item => item.state === "reading").length;

  // Two of this account's own versions, compared. Anything else in the URL is not a request.
  const wanted = requestedDiff(params, versions.map(row => row.version));
  const contents = wanted ? await getLibraryVersionContents(user.id, [wanted.from, wanted.to]) : new Map();
  const from = wanted ? contents.get(wanted.from) : undefined;
  const to = wanted ? contents.get(wanted.to) : undefined;
  const diff = wanted && from && to ? diffCvLibraries(from, to, wanted.from, wanted.to) : null;

  // The employment record a CV's evidence gap was about, if the link named one this account has.
  const job = (library?.content.employment ?? []).some(item => item.id === params.job) ? params.job ?? null : null;

  // The editor is not keyed on the version: a save revalidates this page, and rebuilding the
  // editor from the server would throw away its unsaved-changes state and the version it is
  // writing over. It takes the stored version as a prop and adopts a newer one only when there is
  // nothing on the screen to lose.
  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Library"
        description="The evidence every CV is written from. A block is used only once it is Active and its rows are confirmed."
      />
      <LibraryImportProposals imports={imports} version={library?.version ?? 0} />
      {reading > 0 && <LibraryImportPoller pending={reading} />}
      <CvLibraryEditor
        library={library?.content ?? null}
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
      <LibraryVersions versions={versions} current={library?.version ?? 0} diff={diff} />
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
