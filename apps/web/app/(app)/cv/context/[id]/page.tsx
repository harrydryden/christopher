import Link from "next/link";
import { notFound } from "next/navigation";
import { CvContentSchema } from "@col/core/cv";
import { requireUser } from "@/lib/auth";
import { getOwnCvWorkspace } from "@/lib/queries/cv-workspace";
import { zUuid } from "@/lib/validation";
import { PageHeader } from "@/components/PageHeader";
import { CvContextModes } from "@/components/CvContextModes";
import { CvAutoMode } from "@/components/CvAutoMode";
import type { RefinementTargetOption } from "@/components/CvRefineMode";
import { CvRefineModeLazy, CvManualModeLazy } from "@/components/CvContextLazyModes";
import { CvLibrarySchema } from "@col/core/cv";
import { contactLine } from "@col/core/cv-helpers";
import { cvContextDescriptions, cvLibraries } from "@col/db/schema";
import { db } from "@/lib/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { CvAssessmentPanel } from "@/components/CvAssessmentPanel";
import { cvAssessmentCurrent } from "@col/core/cv-review";
import { resolveCvTheme } from "@col/core/cv";
import { cvDraftEditBaseHash } from "@/lib/cv-edit-base";
import { CvHistory } from "@/components/CvHistory";
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
import { CvRoleDescription } from "@/components/CvRoleDescription";
import { cvComparisonSourceForOwnedDraft } from "@/lib/cv-comparison-source";
import { cvContextInputDrift } from "@/lib/cv-context-drift";
import { CV_RENDER_VERSION, cvRefinementConflicts } from "@col/core/cv-editing-modes";
import { CV_AI_UNITS, getCvAiAllowance, quoteCvAiAction } from "@col/db";
import { CvAiAllowance } from "@/components/CvAiAllowance";

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
  const [allowance, correctionQuote] = await Promise.all([
    getCvAiAllowance(db(), user.id),
    quoteCvAiAction(db(), { userId: user.id, source: { kind: "context", id }, action: "inline_correction" }),
  ]);
  const inlineQuotes = {
    inline_correction: { charge: correctionQuote.charge,
      units: correctionQuote.charge === "role_credit" ? 0 : CV_AI_UNITS.inline_correction,
      priceVersion: correctionQuote.priceVersion },
    inline_refine: { charge: correctionQuote.charge,
      units: correctionQuote.charge === "role_credit" ? 0 : CV_AI_UNITS.inline_refine,
      priceVersion: correctionQuote.priceVersion },
    inline_tailor: { charge: correctionQuote.charge,
      units: correctionQuote.charge === "role_credit" ? 0 : CV_AI_UNITS.inline_tailor,
      priceVersion: correctionQuote.priceVersion },
  };
  const [latestLibrary] = await db().select({ content: cvLibraries.content, version: cvLibraries.version }).from(cvLibraries)
    .where(eq(cvLibraries.userId, user.id)).orderBy(desc(cvLibraries.version)).limit(1);
  const library = latestLibrary ? CvLibrarySchema.safeParse(latestLibrary.content) : null;
  const prefill = library?.success ? { name: library.data.name, contact: contactLine(library.data),
    summary: library.data.profile.slice(0, 850) } : { name: "", contact: "", summary: "" };
  const defaultTheme = resolveCvTheme(library?.success ? library.data.theme : null);
  const selectedDraft = workspace.selectedDraft;
  const [selectedRoleVersion] = selectedDraft?.descriptionVersionId &&
    selectedDraft.descriptionVersionId !== workspace.context.currentDescriptionVersionId
    ? await db().select({ version: cvContextDescriptions.version }).from(cvContextDescriptions)
      .where(and(eq(cvContextDescriptions.id, selectedDraft.descriptionVersionId),
        eq(cvContextDescriptions.contextId, id), eq(cvContextDescriptions.userId, user.id))).limit(1) : [];
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
  const { knownLibraryDrift, knownRoleDrift } = cvContextInputDrift({ selectedBaseline, selectedDraft,
    currentDescriptionVersionId: workspace.context.currentDescriptionVersionId,
    latestLibrary: library?.success ? library.data : null });
  const rebaseBaselines = [...workspace.baselines];
  if (selectedBaseline && !rebaseBaselines.some(row => row.id === selectedBaseline.id))
    rebaseBaselines.unshift({ id: selectedBaseline.id, status: selectedBaseline.status,
      sourceDraftId: selectedBaseline.sourceDraftId, descriptionVersionId: selectedBaseline.descriptionVersionId,
      createdAt: selectedBaseline.createdAt, publishedAt: selectedBaseline.publishedAt });
  const rebaseDescriptionIds = [...new Set(rebaseBaselines.map(row => row.descriptionVersionId).filter((value): value is string => !!value))];
  const rebaseVersions = rebaseDescriptionIds.length ? await db().select({ id: cvContextDescriptions.id,
    version: cvContextDescriptions.version }).from(cvContextDescriptions).where(and(
      eq(cvContextDescriptions.contextId, id), eq(cvContextDescriptions.userId, user.id),
      inArray(cvContextDescriptions.id, rebaseDescriptionIds))) : [];
  const rebaseVersionById = new Map(rebaseVersions.map(row => [row.id, row.version]));
  const auto = <CvAutoMode contextId={id} selectedBaseline={selectedBaseline
    ? { id: selectedBaseline.id, status: selectedBaseline.status, sourceDraftId: selectedBaseline.sourceDraftId,
      rendererCurrent: selectedBaseline.engineContract.render === CV_RENDER_VERSION } : null}
    knownLibraryDrift={knownLibraryDrift} knownRoleDrift={knownRoleDrift}
    initialChoices={selectedBaseline?.librarySnapshot?.careerProjection?.conflictChoices}
    quote={{ charge: correctionQuote.charge,
      units: correctionQuote.charge === "role_credit" ? 0 : CV_AI_UNITS.whole_cv,
      priceVersion: correctionQuote.priceVersion }}
    />;
  const manualEditions = workspace.editions.filter(edition => edition.editingMode === "manual");
  const refinedEditions = workspace.editions.filter(edition => edition.editingMode === "refine");
  const refinementSource = workspace.selected?.kind === "draft" && selectedDraft?.status === "ready" &&
    selectedDraft.content && selectedDraft.editingTargets
      ? { kind: "draft" as const, id: selectedDraft.id,
        revision: selectedDraft.revision,
        label: selectedDraft.editingMode === "manual" ? "selected Manual edition" : "selected saved edition",
        autoOrigin: selectedDraft.editingMode === "auto" || !!selectedDraft.autoBaselineId,
        content: CvContentSchema.parse(selectedDraft.content), targets: selectedDraft.editingTargets,
        library: selectedDraft.librarySnapshot }
    : selectedBaseline?.status === "ready" && selectedBaseline.content && selectedBaseline.editingTargets
    ? { kind: "baseline" as const, id: selectedBaseline.id, label: "selected Auto baseline",
      revision: undefined,
      content: CvContentSchema.parse(selectedBaseline.content), targets: selectedBaseline.editingTargets,
      library: selectedBaseline.librarySnapshot! }
      : null;
  const targetOptions: RefinementTargetOption[] = refinementSource ? [
    { type: "summary", id: refinementSource.targets.summaryId, label: "Summary", sourceText: refinementSource.content.summary },
    ...refinementSource.content.sections.flatMap((section, index) => {
      const ids = refinementSource.targets.sections[index];
      if (!ids || ids.entryId !== section.entryId) return [];
      return [{ type: "section" as const, id: ids.sectionId, label: `${section.heading} · heading`, sourceText: section.heading, entryId: section.entryId },
        ...section.bullets.map((bullet, position) => ({ type: "bullet" as const, id: ids.bulletIds[position],
          label: `${section.heading} · bullet ${position + 1}`, sourceText: bullet,
          sourceSignpost: section.bulletSignposts?.[position] ?? null,
          proseBullet: section.kind !== "skill", entryId: section.entryId })),
        ...(section.skillItems ?? []).map((skill, position) => ({ type: "skill" as const, id: ids.skillIds[position],
          label: `${section.heading} · skill ${position + 1}`, sourceText: skill, entryId: section.entryId }))];
    }),
  ] : [];
  const refinementTargetingView = refinementSource?.kind === "draft" && selectedDraft
    ? await cvTargetingViewForOwnedDraft(user.id, selectedDraft)
    : refinementSource?.kind === "baseline" && selectedBaseline?.content && selectedBaseline.librarySnapshot
      ? cvBaselineTargetingView({ id: selectedBaseline.id, content: CvContentSchema.parse(selectedBaseline.content),
        library: selectedBaseline.librarySnapshot, assessment: selectedBaseline.assessment,
        plan: selectedBaseline.tailoringPlan, snapshot: selectedBaseline.inputSnapshot }) : null;
  const resultTargetingView = selectedDraft?.editingMode === "refine" && selectedDraft.content
    ? await cvTargetingViewForOwnedDraft(user.id, selectedDraft) : null;
  const comparisonSource = selectedDraft?.editingMode === "refine" && selectedDraft.refinementSourceContent
    ? await cvComparisonSourceForOwnedDraft(user.id, id, selectedDraft) : null;
  const unappliedRules = selectedDraft ? workspace.refinements.filter(row =>
    !selectedDraft.appliedRefinements?.some(applied => applied.id === row.id && applied.version === row.version)) : [];
  return <div className="space-y-5">
    <PageHeader title={`${workspace.context.jobTitle} · ${workspace.context.companyName}`}
      actions={<Link href="/applications" className="min-h-11 py-2 text-14 underline">Applications</Link>} />
    <section id="cv-current-cv" role="region" aria-label="Current CV" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Current CV</h2>
        <span className="text-13 text-muted">{selectedDraft
          ? `${selectedDraft.editingMode ?? "saved"} · version ${selectedDraft.revision}${selectedDraft.finalisedAt ? " · final PDF saved" : ""}`
          : selectedBaseline?.status === "ready" ? "Auto · saved result" : "No saved CV yet"}</span>
      </div>
    <CvAiAllowance session={allowance.session} week={allowance.week} />
    {selectedDraft && processing && reading && system && <section className="space-y-3 border border-line-muted p-4 text-14">
      <h2 className="font-semibold">Current CV build</h2>
      <p>Your selected edition is being prepared. Other saved editions and unsaved mode wording remain available.</p>
      <CvBuildLive id={selectedDraft.id} mode="build" initial={reading} nowMs={now.getTime()}
        timeZone={system.timezone} versionLabel={`V${selectedDraft.revision}`} />
    </section>}
    <CvContextModes initialMode={initialMode} auto={auto}
      roleDetails={workspace.description && <CvRoleDescription contextId={id}
        descriptionVersionId={workspace.context.currentDescriptionVersionId}
        description={workspace.description.text} version={workspace.description.version}
        baselines={rebaseBaselines.map(row => ({ id: row.id, status: row.status,
          descriptionVersionId: row.descriptionVersionId, publishedAt: row.publishedAt?.toISOString() ?? null,
          roleVersion: row.descriptionVersionId ? rebaseVersionById.get(row.descriptionVersionId) ?? null : null }))}
        initialFrom={workspace.refinements.find(row => row.dependencies.originBaselineId)?.dependencies.originBaselineId ?? selectedBaseline?.id ?? null}
        originBaselineIds={[...new Set(workspace.refinements.map(row => row.dependencies.originBaselineId).filter((value): value is string => !!value))]}
        refinementVersion={workspace.context.refinementsVersion} refinements={workspace.refinements} />}
      refine={<><CvRefineModeLazy contextId={id} inlineQuotes={inlineQuotes}
        wholeCvQuote={{ charge: correctionQuote.charge,
          units: correctionQuote.charge === "role_credit" ? 0 : CV_AI_UNITS.whole_cv,
          priceVersion: correctionQuote.priceVersion }}
        skillQuote={{ charge: correctionQuote.charge,
          units: correctionQuote.charge === "role_credit" ? 0 : CV_AI_UNITS.skills,
          priceVersion: correctionQuote.priceVersion }}
        skillDraft={selectedDraft?.status === "ready" && selectedDraft.content ? {
          id: selectedDraft.id, revision: selectedDraft.revision, libraryVersion: selectedDraft.libraryVersion } : null}
        source={refinementSource
        ? { kind: refinementSource.kind, id: refinementSource.id, revision: refinementSource.revision, label: refinementSource.label,
          autoOrigin: refinementSource.kind === "baseline" || refinementSource.autoOrigin } : null}
        initialVersion={workspace.context.refinementsVersion} targets={targetOptions} refinements={workspace.refinements}
        appliedRefinements={selectedDraft?.appliedRefinements ??
          (selectedDraft?.editingMode === "refine" && selectedDraft.status === "ready"
            ? selectedDraft.refinementSnapshot?.map(row => ({ id: row.id, version: row.version })) : null) ?? []}
        appliedSnapshot={selectedDraft?.refinementSnapshot ?? []}
        sourceContent={refinementSource?.content} sourceTargets={refinementSource?.targets}
        sourceTheme={refinementSource ? resolveCvTheme(refinementSource.content.theme) : undefined}
        targetingView={refinementTargetingView}
        conflicts={refinementSource && workspace.description ? cvRefinementConflicts({
          content: refinementSource.content, targets: refinementSource.targets, library: refinementSource.library,
          descriptionVersionId: workspace.description.id, refinements: workspace.refinements }) : []} />
      </>}
      manual={<><CvManualModeLazy contextId={id} descriptionVersionId={workspace.context.currentDescriptionVersionId}
        inlineQuotes={inlineQuotes}
        copySource={workspace.selected ? { kind: workspace.selected.kind, id: workspace.selected.id } : null}
        draft={selectedDraft?.editingMode === "manual" ? { id: selectedDraft.id, revision: selectedDraft.revision,
          content: selectedDraft.content, editingTargets: selectedDraft.editingTargets } : null} prefill={prefill}
        initialTheme={resolveCvTheme(selectedDraft?.editingMode === "manual" ? selectedDraft.content?.theme : defaultTheme)}
        skillChoices={library?.success ? library.data.entries.filter(entry => entry.kind === "skill" && entry.status === "active")
          .flatMap(entry => entry.skillItems ?? []) : []} />
      </>}
      compare={selectedDraft?.editingMode === "refine" && selectedDraft.content && selectedDraft.refinementSourceContent
        ? <CvEditionComparison source={CvContentSchema.parse(selectedDraft.refinementSourceContent)}
            result={CvContentSchema.parse(selectedDraft.content)}
            sourceTargets={selectedDraft.refinementSourceTargets} resultTargets={selectedDraft.editingTargets}
            sourceTargeting={comparisonSource?.sourceTargeting} resultTargeting={resultTargetingView}
            sourceLabel={selectedDraft.parentId ? "Previous saved CV" : "Auto source"} /> : null}
      history={(workspace.baselines.length > 0 || workspace.editions.length > 0)
        ? <CvHistory contextId={id} selected={workspace.selected} initialBaselines={workspace.baselines}
            initialEditions={workspace.editions} initialOlder={workspace.older} /> : null} />
    {!selectedDraft?.content && <div className="border border-line-muted p-4 text-14">
      {selectedBaseline?.status === "ready" && selectedBaseline.content ? <>
        <p>Selected Auto result · {CvContentSchema.parse(selectedBaseline.content).name}</p>
        {selectedBaseline.engineContract.render === CV_RENDER_VERSION
          ? <a className="inline-flex min-h-11 items-center underline" href={`/api/cv/baseline/${selectedBaseline.id}/pdf`}
              target="_blank" rel="noopener noreferrer">Open current saved PDF preview</a>
          : <p>This saved result used an earlier PDF layout. Update Auto to preview it with the current layout.</p>}
      </> : <p>No ready CV is selected yet. Choose Auto or Manual to begin.</p>}
    </div>}
    {selectedDraft?.content && <div id="cv-context-feedback" className="border border-line-muted p-4 text-14">
      <div className="mt-3 space-y-2 border-b border-line-muted pb-3">
        <h2 tabIndex={-1} className="font-semibold">Feedback and final approval</h2>
        <p>{CvContentSchema.parse(selectedDraft.content).name} · {selectedDraft.finalisedAt ? "Finalised PDF ready" : processing
          ? "Build in progress; saved wording remains available" : "Saved wording ready for review"}</p>
        {selectedRoleVersion && <p className="text-12 text-muted">Based on role description version {selectedRoleVersion.version}; current role description is version {workspace.description?.version}. Your saved wording remains on its earlier source.</p>}
        <div className="flex flex-wrap gap-4">
          <a className="inline-flex min-h-11 items-center underline" href={`/api/cv/${selectedDraft.id}/pdf${selectedDraft.finalisedAt ? "" : "?preview=1"}`}
            target="_blank" rel="noopener noreferrer">{selectedDraft.finalisedAt ? "Download final PDF" : "Open selected saved PDF preview"}</a>
          <Link className="inline-flex min-h-11 items-center underline" href={`/cv/${selectedDraft.id}`}>Open saved version details</Link>
        </div>
        <p className="text-12 text-muted">Feedback and approval use this saved edition. Unsaved mode wording and remembered changes are excluded until saved and applied.</p>
      </div>
      {unappliedRules.length > 0 && <p role="status" className="mt-2 border border-warn p-3 text-12 text-warn">
        {unappliedRules.length} remembered {unappliedRules.length === 1 ? "change has" : "changes have"} not been applied to this saved edition.
      </p>}
      {selectedDraft.editingMode === "manual" && cvManualHeadingWarnings(
        CvContentSchema.parse(selectedDraft.content), selectedDraft.librarySnapshot).length > 0 &&
        <div className="mt-3 border border-warn p-3 text-14"><p className="font-medium">Headings to verify</p>
          <ul className="mt-2 list-disc pl-5">{cvManualHeadingWarnings(CvContentSchema.parse(selectedDraft.content),
            selectedDraft.librarySnapshot).map(warning => <li key={warning.id}>{warning.text}</li>)}</ul></div>}
      <div className="mt-3"><CvAssessmentPanel checkQuote={{ charge: correctionQuote.charge, units: correctionQuote.charge === "role_credit" ? 0 : CV_AI_UNITS.check, priceVersion: correctionQuote.priceVersion }} id={selectedDraft.id} revision={selectedDraft.revision}
        checkSuccessHash="cv-context-feedback"
        baseHash={cvDraftEditBaseHash(selectedDraft.content, selectedDraft.targetingBrief)}
        assessment={selectedDraft.assessment} current={cvAssessmentCurrent(selectedDraft.assessment,
          CvContentSchema.parse(selectedDraft.content), selectedDraft.jobDescription, selectedDraft.librarySnapshot)}
        finalised={!!selectedDraft.finalisedAt} hasFinalPdf={hasFinalPdf} approvalMode={approvalMode}
        busy={selectedDraft.status === "queued" || selectedDraft.status === "generating"}
        hasContent content={CvContentSchema.parse(selectedDraft.content)} library={selectedDraft.librarySnapshot} /></div>
    </div>}
    </section>
  </div>;
}
