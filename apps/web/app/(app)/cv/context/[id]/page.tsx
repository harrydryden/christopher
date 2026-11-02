import Link from "next/link";
import { notFound } from "next/navigation";
import { CvContentSchema } from "@col/core/cv";
import { requireUser } from "@/lib/auth";
import { getOwnCvWorkspace } from "@/lib/queries/cv-workspace";
import { zUuid } from "@/lib/validation";
import { PageHeader } from "@/components/PageHeader";
import { CvContextModes } from "@/components/CvContextModes";
import { CvAutoMode } from "@/components/CvAutoMode";
import { CvRefineMode, type RefinementTargetOption } from "@/components/CvRefineMode";
import { CvManualMode } from "@/components/CvManualMode";
import { CvLibrarySchema } from "@col/core/cv";
import { contactLine } from "@col/core/cv-helpers";
import { cvLibraries } from "@col/db/schema";
import { db } from "@/lib/db";
import { desc, eq } from "drizzle-orm";
import { CvAppearance } from "@/components/CvAppearance";
import { CvAssessmentPanel } from "@/components/CvAssessmentPanel";
import { cvAssessmentCurrent } from "@col/core/cv-review";
import { resolveCvTheme } from "@col/core/cv";
import { cvDraftEditBaseHash } from "@/lib/cv-edit-base";
import { CvSelectEdition } from "@/components/CvSelectEdition";
import { cvManualHeadingWarnings } from "@col/core/cv-employment-display";
import { storedFinalisedCvPdfStatus } from "@/lib/cv-pdf-store";
import { cvTargetingViewForOwnedDraft } from "@/lib/cv-targeting-view";
import { cvBaselineTargetingView } from "@/lib/cv-baseline-targeting-view";
import { readCvProgress } from "@/lib/queries/cv";
import { cvProgressReading } from "@/lib/cv-progress";
import { CvBuildLive } from "@/components/CvBuildLive";
import { getSystemSettings } from "@/lib/settings";
import { isAdmin } from "@/lib/auth";
import { CvEditionComparison } from "@/components/CvEditionComparison";
import { CV_RENDER_VERSION, cvRefinementConflicts } from "@col/core/cv-editing-modes";

export const dynamic = "force-dynamic";

export default async function CvContextPage({ params, searchParams }: { params: Promise<{ id: string }>;
  searchParams: Promise<{ baselinesBefore?: string; editionsBefore?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  if (!zUuid().safeParse(id).success) notFound();
  const history = await searchParams;
  const workspace = await getOwnCvWorkspace(user.id, id, {
    baselines: history.baselinesBefore, editions: history.editionsBefore,
  });
  if (!workspace) notFound();
  const [latestLibrary] = await db().select({ content: cvLibraries.content }).from(cvLibraries)
    .where(eq(cvLibraries.userId, user.id)).orderBy(desc(cvLibraries.version)).limit(1);
  const library = latestLibrary ? CvLibrarySchema.safeParse(latestLibrary.content) : null;
  const prefill = library?.success ? { name: library.data.name, contact: contactLine(library.data),
    summary: library.data.profile.slice(0, 850) } : { name: "", contact: "", summary: "" };
  const defaultTheme = resolveCvTheme(library?.success ? library.data.theme : null);
  const selectedDraft = workspace.selectedDraft;
  const pdfStatus = selectedDraft?.finalisedAt
    ? await storedFinalisedCvPdfStatus(user.id, selectedDraft.id) : null;
  const hasFinalPdf = !!pdfStatus;
  const approvalMode = pdfStatus?.approvalMode ?? null;
  const processing = selectedDraft?.status === "queued" || selectedDraft?.status === "generating";
  const progress = processing && selectedDraft ? await readCvProgress(user.id, selectedDraft.id) : null;
  const [system, admin] = processing ? await Promise.all([getSystemSettings(), isAdmin()]) : [null, false];
  const now = new Date();
  const reading = processing && selectedDraft && system ? cvProgressReading({ draft: selectedDraft,
    task: progress?.task ?? null, anyTaskActive: progress?.anyTaskActive ?? false,
    steps: progress?.steps ?? [], signature: progress?.signature ?? "0:0:" }, now, system.timezone, admin) : null;
  const initialMode = selectedDraft?.editingMode === "manual" ? "manual"
    : selectedDraft?.editingMode === "refine" ? "refine" : "auto";
  const selectedBaseline = workspace.selectedBaseline;
  const autoSummary = selectedBaseline?.content ? (() => {
    const content = CvContentSchema.parse(selectedBaseline.content);
    return <div className="space-y-2 text-14">
      <p className="font-medium">{content.name}</p>
      <p>{content.summary}</p>
      <p className="text-12 text-muted">{content.sections.length} saved sections</p>
    </div>;
  })() : null;
  const auto = <CvAutoMode contextId={id} selectedBaseline={selectedBaseline
    ? { id: selectedBaseline.id, status: selectedBaseline.status, sourceDraftId: selectedBaseline.sourceDraftId,
      rendererCurrent: selectedBaseline.engineContract.render === CV_RENDER_VERSION } : null}
    summary={autoSummary}
    baselines={workspace.baselines.map(row => ({ id: row.id, status: row.status,
      sourceDraftId: row.sourceDraftId, publishedAt: row.publishedAt?.toISOString() ?? null }))} />;
  const manualEditions = workspace.editions.filter(edition => edition.editingMode === "manual");
  const refinedEditions = workspace.editions.filter(edition => edition.editingMode === "refine");
  const refinementSource = workspace.selected?.kind === "draft" && selectedDraft?.status === "ready" &&
    (!selectedBaseline || selectedDraft.refinementOriginKind === "manual") &&
    selectedDraft.editingMode !== "auto" && selectedDraft.content && selectedDraft.editingTargets
      ? { kind: "draft" as const, id: selectedDraft.id,
        label: selectedDraft.editingMode === "manual" ? "selected Manual edition" : "selected saved edition",
        autoOrigin: !!selectedDraft.autoBaselineId,
        content: CvContentSchema.parse(selectedDraft.content), targets: selectedDraft.editingTargets,
        library: selectedDraft.librarySnapshot }
    : selectedBaseline?.status === "ready" && selectedBaseline.content && selectedBaseline.editingTargets
    ? { kind: "baseline" as const, id: selectedBaseline.id, label: "selected Auto baseline",
      content: CvContentSchema.parse(selectedBaseline.content), targets: selectedBaseline.editingTargets,
      library: selectedBaseline.librarySnapshot! }
      : null;
  const targetOptions: RefinementTargetOption[] = refinementSource ? [
    { type: "summary", id: refinementSource.targets.summaryId, label: "Summary", sourceText: refinementSource.content.summary },
    ...refinementSource.content.sections.flatMap((section, index) => {
      const ids = refinementSource.targets.sections[index];
      if (!ids || ids.entryId !== section.entryId) return [];
      return [{ type: "section" as const, id: ids.sectionId, label: `${section.heading} · heading`, sourceText: section.heading },
        ...section.bullets.map((bullet, position) => ({ type: "bullet" as const, id: ids.bulletIds[position],
          label: `${section.heading} · bullet ${position + 1}`, sourceText: bullet })),
        ...(section.skillItems ?? []).map((skill, position) => ({ type: "skill" as const, id: ids.skillIds[position],
          label: `${section.heading} · skill ${position + 1}`, sourceText: skill }))];
    }),
  ] : [];
  const refinementTargetingView = refinementSource?.kind === "draft" && selectedDraft
    ? await cvTargetingViewForOwnedDraft(user.id, selectedDraft)
    : refinementSource?.kind === "baseline" && selectedBaseline?.content && selectedBaseline.librarySnapshot
      ? cvBaselineTargetingView({ id: selectedBaseline.id, content: CvContentSchema.parse(selectedBaseline.content),
        library: selectedBaseline.librarySnapshot, assessment: selectedBaseline.assessment,
        plan: selectedBaseline.tailoringPlan, snapshot: selectedBaseline.inputSnapshot }) : null;
  return <div className="space-y-5">
    <PageHeader title={`${workspace.context.jobTitle} · ${workspace.context.companyName}`}
      description="One application workspace. Choose Auto, Refine or Manual; your saved editions remain separate."
      actions={<Link href="/applications" className="min-h-11 py-2 text-14 underline">Applications</Link>} />
    {workspace.description && <details className="border border-line-muted p-3 text-14">
      <summary className="cursor-pointer font-medium">Saved role description · version {workspace.description.version}</summary>
      <p className="mt-3 whitespace-pre-wrap">{workspace.description.text}</p>
    </details>}
    {selectedDraft && processing && reading && system && <section className="space-y-3 border border-line-muted p-4 text-14">
      <h2 className="font-semibold">Current CV build</h2>
      <p>Your selected edition is being prepared. Other saved editions and unsaved mode wording remain available.</p>
      <CvBuildLive id={selectedDraft.id} mode="build" initial={reading} nowMs={now.getTime()}
        timeZone={system.timezone} versionLabel={`V${selectedDraft.revision}`} />
    </section>}
    <CvContextModes initialMode={initialMode} auto={auto}
      refine={<><CvRefineMode contextId={id} source={refinementSource
        ? { kind: refinementSource.kind, id: refinementSource.id, label: refinementSource.label,
          autoOrigin: refinementSource.kind === "baseline" || refinementSource.autoOrigin } : null}
        initialVersion={workspace.context.refinementsVersion} targets={targetOptions} refinements={workspace.refinements}
        sourceContent={refinementSource?.content} sourceTargets={refinementSource?.targets}
        sourceTheme={refinementSource ? resolveCvTheme(refinementSource.content.theme) : undefined}
        targetingView={refinementTargetingView}
        conflicts={refinementSource && workspace.description ? cvRefinementConflicts({
          content: refinementSource.content, targets: refinementSource.targets, library: refinementSource.library,
          descriptionVersionId: workspace.description.id, refinements: workspace.refinements }) : []} />
        {selectedDraft?.editingMode === "refine" && selectedDraft.content && selectedDraft.refinementSourceContent &&
          <CvEditionComparison source={CvContentSchema.parse(selectedDraft.refinementSourceContent)}
            result={CvContentSchema.parse(selectedDraft.content)}
            sourceLabel={selectedDraft.refinementOriginKind === "manual" ? "Manual source" : "Auto source"} />}
        {refinedEditions.length > 0 && <ul className="mt-3 space-y-2 text-14">{refinedEditions.map(edition =>
          <li key={edition.id} className="flex flex-wrap items-center gap-2"><CvSelectEdition contextId={id} kind="draft" id={edition.id}
            label={`Select Refine edition V${edition.revision}`} /><Link className="underline" href={`/cv/${edition.id}`}>Open details</Link> · {edition.status}</li>)}</ul>}
      </>}
      manual={<><CvManualMode contextId={id} descriptionVersionId={workspace.context.currentDescriptionVersionId}
        copySource={workspace.selected ? { kind: workspace.selected.kind, id: workspace.selected.id } : null}
        draft={selectedDraft?.editingMode === "manual" ? { id: selectedDraft.id, revision: selectedDraft.revision,
          content: selectedDraft.content, editingTargets: selectedDraft.editingTargets } : null} prefill={prefill}
        initialTheme={resolveCvTheme(selectedDraft?.editingMode === "manual" ? selectedDraft.content?.theme : defaultTheme)} />
        {manualEditions.length > 0 && <ul className="space-y-2">{manualEditions.map(edition =>
          <li key={edition.id} className="flex flex-wrap items-center gap-2"><CvSelectEdition contextId={id} kind="draft" id={edition.id}
            label={`Select Manual edition V${edition.revision}`} /><Link className="underline" href={`/cv/${edition.id}`}>Open details</Link> · {edition.status}</li>)}</ul>}
      </>} />
    {selectedDraft?.content && <div className="border border-line-muted p-4 text-14">
      <h2 className="font-semibold">Selected saved edition</h2>
      <p>{CvContentSchema.parse(selectedDraft.content).name} · {selectedDraft.editingMode ?? "Historical"} · {selectedDraft.status}</p>
      <Link className="underline" href={`/cv/${selectedDraft.id}`}>Open this saved edition</Link>
    </div>}
    {selectedDraft?.content && <details className="border border-line-muted p-4 text-14">
      <summary className="cursor-pointer font-semibold">Layout and PDF</summary>
      <p className="mt-3 text-12 text-muted">This saved edition has its own appearance. {selectedDraft.editingMode === "manual"
        ? "Choose Manual above to change Layout, then Save that edition."
        : selectedDraft.editingMode === "refine"
          ? "Choose Refine above to remember a Layout change, then apply the saved refinement."
          : "Choose Refine above to change Layout while keeping Auto as your starting point."}</p>
      <fieldset disabled className="mt-3"><CvAppearance value={resolveCvTheme(selectedDraft.content.theme)} /></fieldset>
      <a className="mt-3 inline-flex min-h-11 items-center underline" href={`/api/cv/${selectedDraft.id}/pdf?preview=1`}
        target="_blank" rel="noopener noreferrer">Open saved PDF preview</a>
    </details>}
    {selectedDraft?.content && <details open className="border border-line-muted p-4 text-14">
      <summary className="cursor-pointer font-semibold">Feedback and final approval</summary>
      {selectedDraft.editingMode === "manual" && cvManualHeadingWarnings(
        CvContentSchema.parse(selectedDraft.content), selectedDraft.librarySnapshot).length > 0 &&
        <div className="mt-3 border border-warn p-3 text-14"><p className="font-medium">Headings to verify</p>
          <ul className="mt-2 list-disc pl-5">{cvManualHeadingWarnings(CvContentSchema.parse(selectedDraft.content),
            selectedDraft.librarySnapshot).map(warning => <li key={warning.id}>{warning.text}</li>)}</ul></div>}
      <div className="mt-3"><CvAssessmentPanel id={selectedDraft.id} revision={selectedDraft.revision}
        baseHash={cvDraftEditBaseHash(selectedDraft.content, selectedDraft.targetingBrief)}
        assessment={selectedDraft.assessment} current={cvAssessmentCurrent(selectedDraft.assessment,
          CvContentSchema.parse(selectedDraft.content), selectedDraft.jobDescription, selectedDraft.librarySnapshot)}
        finalised={!!selectedDraft.finalisedAt} hasFinalPdf={hasFinalPdf} approvalMode={approvalMode}
        busy={selectedDraft.status === "queued" || selectedDraft.status === "generating"}
        hasContent content={CvContentSchema.parse(selectedDraft.content)} library={selectedDraft.librarySnapshot} /></div>
    </details>}
    {workspace.older && <Link className="inline-flex min-h-11 items-center text-14 underline"
      href={`/cv/context/${id}?baselinesBefore=${encodeURIComponent(workspace.older.baselines)}&editionsBefore=${encodeURIComponent(workspace.older.editions)}`}>Older saved editions</Link>}
  </div>;
}
