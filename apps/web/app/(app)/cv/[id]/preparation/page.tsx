import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { libraryImports, cvTailoringPlans } from "@col/db";
import { CvContentSchema, CvLibrarySchema } from "@col/core/cv";
import { cvEmploymentDisplay } from "@col/core/cv-employment-display";
import { StoredLibraryProposalSchema } from "@col/core/library-import";
import { CvTailoringPlanSchema, cvTailoringEvidence, validateCvTailoringPlan } from "@col/core/cv-tailoring";
import { renderCvPdfWithReport } from "@col/core/cv-pdf";
import { cvAssessmentCurrent } from "@col/core/cv-review";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getOwnCvDraft } from "@/lib/queries/cv";
import { cvPendingSkillViewForOwnedDraft } from "@/lib/cv-pending-skills-view";
import { CvPendingSkillPanel } from "@/components/CvPendingSkillPanel";
import { zUuid } from "@/lib/validation";
import { compareCvWithLinkedIn, cvEmphasisScan, cvInterviewCards, cvQuickScan, linkedInImportHasConfirmedEvidence } from "@/lib/cv-preparation";
import { refuseCvRender, CV_RENDER_BUSY_SENTENCE } from "@/lib/cv-render-limit";
import { hasStoredFinalisedCvPdf } from "@/lib/cv-pdf-store";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function CvPreparationPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ linkedinImport?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  if (!zUuid().safeParse(id).success) notFound();
  const draft = await getOwnCvDraft(user.id, id);
  if (!draft) notFound();
  const pendingSkills = cvPendingSkillViewForOwnedDraft(user.id, draft);
  const content = draft.content ? CvContentSchema.parse(draft.content) : null;
  const library = CvLibrarySchema.parse(draft.librarySnapshot);
  const renderRefusal = content && !draft.finalisedAt ? await refuseCvRender(user.id) : null;
  const finalPdfAvailable = draft.finalisedAt ? await hasStoredFinalisedCvPdf(user.id, draft.id) : false;
  const [rendered, imports, storedPlan] = await Promise.all([
    content && !draft.finalisedAt && !renderRefusal
      ? renderCvPdfWithReport(content, cvEmploymentDisplay(content, library)).then(result => ({ layout: result.layout, pageCount: result.pageCount })).catch(() => null)
      : Promise.resolve(null),
    db().select({ id: libraryImports.id, filename: libraryImports.filename, processedAt: libraryImports.processedAt,
      hasContent: sql<boolean>`${libraryImports.content} is not null` })
      .from(libraryImports).where(and(eq(libraryImports.userId, user.id), eq(libraryImports.kind, "linkedin")))
      .orderBy(desc(libraryImports.createdAt)).limit(20),
    draft.targetingBrief ? db().select({ plan: cvTailoringPlans.plan }).from(cvTailoringPlans)
      .where(and(eq(cvTailoringPlans.draftId, id), eq(cvTailoringPlans.userId, user.id))).limit(1)
      : Promise.resolve([]),
  ]);
  const selectedId = (await searchParams).linkedinImport;
  const selected = selectedId && zUuid().safeParse(selectedId).success && imports.some(item => item.id === selectedId)
    ? imports.find(item => item.id === selectedId) : null;
  const [selectedData] = selected ? await db().select({ content: libraryImports.content, proposal: libraryImports.proposal,
    resolvedAt: libraryImports.resolvedAt })
    .from(libraryImports).where(and(eq(libraryImports.id, selected.id), eq(libraryImports.userId, user.id),
      eq(libraryImports.kind, "linkedin"))).limit(1) : [];
  const proposal = selectedData ? StoredLibraryProposalSchema.safeParse(selectedData.proposal) : null;
  const sourceReviewed = !!selected && !!selectedData && linkedInImportHasConfirmedEvidence(library, selected.id, selectedData.resolvedAt);
  const comparison = sourceReviewed && selectedData?.content && proposal?.success
    ? compareCvWithLinkedIn(library, proposal.data, selectedData.content, selected.id) : [];
  const rubric = draft.targetingBrief?.priority.rubric ?? draft.assessment?.rubric ?? draft.buildCheckpoint?.sourceRubric;
  let mappedSourceIds: string[] = [];
  const planCandidate = storedPlan[0]?.plan ?? draft.buildCheckpoint?.tailoringPlan;
  if (rubric && planCandidate) {
    try {
      const plan = validateCvTailoringPlan(CvTailoringPlanSchema.parse(planCandidate), rubric,
        cvTailoringEvidence(library), library);
      mappedSourceIds = plan.requirements.flatMap(item => item.evidence.map(ref => ref.sourceId));
    } catch { /* Stale or invalid plans cannot establish role relevance. */ }
  }
  const cards = cvInterviewCards(library, draft.targetingBrief, mappedSourceIds);
  const scan = content && rendered ? cvQuickScan(content, rendered.layout) : null;
  const currentAssessment = content && draft.assessment && cvAssessmentCurrent(draft.assessment, content,
    draft.jobDescription, library) ? draft.assessment : null;
  const emphasis = cvEmphasisScan(draft.targetingBrief, currentAssessment, rendered?.layout ?? null, content);
  const firstPageEntries = new Map(content?.sections.filter(section => scan?.firstPageEntryIds.includes(section.entryId))
    .map(section => [section.entryId, section.heading]) ?? []);
  return <div className="mx-auto max-w-4xl space-y-6">
    <Link prefetch={false} href={`/cv/${id}#cv-panel-evaluation`} className="text-14 underline">← Back to this CV</Link>
    <header><h1 className="text-24 font-semibold">Quick scan and preparation</h1>
      <p className="text-14 text-muted">These views use this saved CV revision and your own uploaded or confirmed evidence. They do not change the CV.</p></header>
    <section className="space-y-3 border border-line-muted p-4">
      <h2 className="text-18 font-semibold">Saved CV quick scan</h2>
      {draft.finalisedAt ? <p className="text-14">This finalised revision uses its stored, approved PDF. A page-by-page layout report for those historical bytes is unavailable; the current renderer would not prove what was approved.</p>
        : renderRefusal ? <p className="text-14">{CV_RENDER_BUSY_SENTENCE}</p>
        : !scan ? <p className="text-14">Save a CV revision before opening its scan.</p> : <>
        <p className="text-14">About {scan.wordCount} printed words · Executive Summary {scan.summaryLines} rendered {scan.summaryLines === 1 ? "line" : "lines"} · {rendered?.pageCount} measured {rendered?.pageCount === 1 ? "page" : "pages"}</p>
        <p className="text-12 text-muted">{scan.summaryLines > 3 ? "The summary runs beyond three rendered lines; consider shortening it for a quicker first read." : "The summary fits within three rendered lines."} {scan.wordCount > 600 ? "This CV is over the 500–600-word starting point; check its readability in the PDF." : "Word count is an editorial guide, not a pass or fail score."}</p>
        {draft.targetingBrief && <p className="text-14">Body {draft.targetingBrief.presentation.bodySizePt} pt · maximum {draft.targetingBrief.presentation.maxPages} {draft.targetingBrief.presentation.maxPages === 1 ? "page" : "pages"}{rendered && rendered.pageCount > draft.targetingBrief.presentation.maxPages ? " · over the selected limit" : ""}</p>}
        {draft.targetingBrief?.priority.emphasisRequirementIds.length ? <div className="space-y-1 text-14"><p className="font-medium">Selected priorities in this saved CV</p>
          {emphasis.length ? <ul className="list-disc pl-5">{emphasis.map(item => <li key={item.id}>{item.label}: {item.status === "first_page" ? "audited support begins on page one" : item.status === "elsewhere" ? "audited support begins after page one" : "not confirmed in the current assessment"}{item.terminologyOnFirstPage ? "; exact priority wording appears in that supported page-one claim" : ""}</li>)}</ul>
            : <p>Check this saved revision to see audited priority evidence by page.</p>}</div> : null}
        <p className="text-14 font-medium">Executive Summary</p><p className="text-14">{scan.summary}</p>
        <p className="text-14 font-medium">Begins on the first page</p>
        {firstPageEntries.size ? <ul className="list-disc space-y-1 pl-5 text-14">{[...firstPageEntries].map(([entryId, heading]) =>
          <li key={entryId}>{heading}</li>)}</ul> : <p className="text-14">Only the summary begins on page one.</p>}
        {scan.firstPageClaims.length ? <ul className="list-disc space-y-1 pl-5 text-14">{scan.firstPageClaims.map(item =>
          <li key={item.id}>{item.text}</li>)}</ul> : <p className="text-14">No supporting bullet begins on page one.</p>}
        <p className="text-12 text-muted">A bullet starting on page one may continue onto page two. Use the PDF below to check the visible first page.</p>
      </>}
      {(scan || finalPdfAvailable) && <><iframe title="Saved CV PDF, first page" src={`/api/cv/${id}/pdf?preview=1#page=1&view=FitH`}
        className="h-[620px] w-full border border-line-muted" />
        <a className="underline text-14" href={`/api/cv/${id}/pdf?preview=1`} target="_blank" rel="noopener noreferrer">Open this saved PDF in a new tab</a></>}
    </section>
    <section className="space-y-3 border border-line-muted p-4"><h2 className="text-18 font-semibold">Uploaded LinkedIn consistency</h2>
      <p className="text-14">Choose one of your uploaded LinkedIn exports. We do not read your live profile or follow its URL. Comparisons are limited to explicit fields anchored in retained upload text; silence or ambiguity means unknown.</p>
      {imports.length ? <form method="get" className="flex flex-wrap items-end gap-2"><label className="text-14">Uploaded export
        <select name="linkedinImport" defaultValue={selected?.id ?? ""} className="ml-2 border p-2"><option value="">Choose an upload</option>
          {imports.map(item => <option key={item.id} value={item.id}>{item.filename ?? "LinkedIn export"} · {item.processedAt ? "read" : "not yet read"}</option>)}</select></label>
        <button className="border px-3 py-2 text-14" type="submit">Compare this upload</button></form>
        : <p className="text-14">No LinkedIn export is available here. <Link prefetch={false} href="/library" className="underline">Upload your own LinkedIn PDF or paste profile text in Experience</Link>.</p>}
      {selected && (!selectedData?.content || !proposal?.success) && <p className="text-14">The retained text or reviewed proposal for this upload is unavailable. Re-upload it in Experience to compare.</p>}
      {selected && selectedData?.content && proposal?.success && !sourceReviewed && <p className="text-14">Unknown: this upload has no identifiable, person-confirmed Experience row in the saved Library. Dismissed, merged, pruned or unconfirmed uploads cannot establish this comparison. Review its suggestions in Experience first.</p>}
      {selected && sourceReviewed && selectedData?.content && proposal?.success && (comparison.length ? <ul className="space-y-2">{comparison.map((item, index) =>
        <li key={`${item.field}:${index}`} className="border border-line-muted p-2 text-14"><strong>{item.field} · {item.status === "corroborating" ? "Corroborating" : "Needs review"}</strong>
          <span className="block">Saved Experience: {item.saved}</span><span className="block">Uploaded wording: {item.uploaded}</span>
          <span className="block text-12 text-muted">Source passage: “{item.quote}”</span></li>)}</ul>
        : <p className="text-14">No unambiguous, comparable fields were found in this retained upload. The result is unknown; it does not mean the sources agree.</p>)}
    </section>
    <section className="space-y-3 border border-line-muted p-4"><h2 className="text-18 font-semibold">Interview preparation from omitted evidence</h2>
      {!cards.length ? <p className="text-14">No confirmed, omitted responsibilities are available for preparation on this CV.</p>
        : <ul className="space-y-3">{cards.map((card, index) => <li key={`${card.entryId}:${index}`} className="border border-line-muted p-3 text-14">
          <strong>{card.heading}{card.employer ? ` · ${card.employer}` : ""}{card.dates ? ` · ${card.dates}` : ""}</strong>
          <p className="mt-1">Confirmed Experience: “{card.evidence}”</p>
          <p className="mt-1 text-12 text-muted">{card.relevance === "role_mapped" ? "This exact evidence row was mapped in the saved role plan." : "Additional confirmed evidence; role relevance has not been checked."} Be ready to explain your part, the context and the result in your own words.</p>
        </li>)}</ul>}
    </section>
    <CvPendingSkillPanel view={pendingSkills} />
  </div>;
}
