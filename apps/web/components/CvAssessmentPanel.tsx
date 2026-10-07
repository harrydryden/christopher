import { cvMaxPages, type CvContent, type CvLibrary } from "@col/core/cv";
import type { CvAssessment } from "@col/core/cv-assessment";
import { diagnoseCvQuality } from "@col/core/cv-quality";
import { assessCvDraft } from "@/app/actions/cv";
import { cvReviewDecisionCurrent, type CvReviewDecision } from "@col/core/cv-review";
import { cvEvaluationRows, type CvCommentInput } from "@/lib/cv-evaluation";
import { CvEvaluationTable } from "./CvLazyWidgets";
import { SettingsForm } from "./SettingsForm";
import { CvReviewControls } from "./CvReviewControls";

/** Explain source changes where the evidence is judged; rewriting stays in the Write controls. */
function LibraryDrift({ sentence }: { sentence: string | null }) {
  if (!sentence) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 border border-warn p-3 text-14">
      <p className="text-warn">{sentence}</p>
      <p>Use More options in Write if you want a new draft from the latest Experience.</p>
    </div>
  );
}

export function CvAssessmentPanel({
  id,
  assessment,
  current,
  finalised,
  hasFinalPdf = false,
  busy,
  hasContent,
  content,
  library = null,
  libraryDrift = null,
  finaliseReason = null,
  blocked = null,
  comments = [],
  initialFindingId = null,
  reviewDecision = null,
}: {
  id: string;
  assessment: CvAssessment | null;
  current: boolean;
  finalised: boolean;
  hasFinalPdf?: boolean;
  busy: boolean;
  hasContent: boolean;
  content: CvContent | null;
  /** This revision's own Library snapshot: what a gap row's "Add evidence" link is resolved against. */
  library?: Pick<CvLibrary, "entries"> | null;
  /** "Your Library changed since this build (v7 → v9).", or null while the build is up to date. */
  libraryDrift?: string | null;
  /**
   * Why this revision cannot be finalised, in the sentence `assertCvFinalisable` would throw, or
   * null when it can be. Computed on the page with the same function the action re-runs, so the
   * control's absence is explained rather than silent.
   */
  finaliseReason?: string | null;
  /** Why assessing is unavailable — an unverified account — or null when it is not. */
  blocked?: string | null;
  /**
   * Notes left through this CV's share links. They become their own rows in the table — a reader's
   * opinion beside the reviewer's findings — and never change a score, a status or a rating.
   */
  comments?: CvCommentInput[];
  initialFindingId?: string | null;
  reviewDecision?: CvReviewDecision | null;
}) {
  if (!assessment || !current)
    return (
      <section className="border border-warn p-4 space-y-3">
        <h2 className="text-14 font-semibold">Job match assessment</h2>
        <p className="text-14">{finalised
          ? hasFinalPdf
            ? "This finalised revision no longer has a current assessment. Its saved PDF is still available; create a new revision for a current review."
            : "This finalised revision has no saved PDF available. Create a new revision, check it and finalise again."
          : busy ? "Assessment pending" : "Assessment required"}</p>
        {!busy && !finalised && finaliseReason && (
          <p className="text-14 text-warn">{finaliseReason}</p>
        )}
        {!finalised && <LibraryDrift sentence={libraryDrift} />}
        {!busy && !finalised && (
          <>
            <fieldset disabled={!!blocked} className="min-w-0">
              <SettingsForm
                action={assessCvDraft.bind(null, id)}
                submitLabel={
                  hasContent ? "Fit and assess saved revision" : "Retry generation"
                }
              >
                <></>
              </SettingsForm>
            </fieldset>
            {blocked && <p role="status" className="text-14 text-warn">{blocked}</p>}
          </>
        )}
      </section>
    );
  const flagged = assessment.review.claims.filter(
    (claim) => claim.status !== "supported",
  );
  // What this panel can see for itself, so a caller that passes no reason still never offers a
  // finalisation the action would refuse.
  const overPages = assessment.pageCount > cvMaxPages(content?.theme);
  const rows = cvEvaluationRows(assessment, content, library, comments);
  const decision = cvReviewDecisionCurrent(reviewDecision, assessment) ? reviewDecision : null;
  const factualRowIds = flagged.map((claim) => `claim:${claim.claimId}`);
  const essentialGaps = rows.filter(
    (row) => row.importance === "essential" && row.experience !== "Strong",
  ).length;
  const quality = content ? diagnoseCvQuality(assessment, content) : null;
  return (
    <section
      className="space-y-4 border border-line-muted p-4"
      aria-labelledby="cv-match-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="cv-match-title" className="text-14 font-semibold">
            CV evaluation
          </h2>
          <p className="text-14 text-muted">
            {assessment.pageCount}{" "}
            {assessment.pageCount === 1 ? "page" : "pages"}
          </p>
        </div>
      </div>
      <p className="text-14 text-muted">
        Match <strong>{assessment.score}/100</strong>{" · "}Experience evidence:{" "}
        <strong>{assessment.availableEvidenceScore}/100</strong>
        {" · "}
        {essentialGaps} essential requirements to review
        {" · "}
        {flagged.length} factual {flagged.length === 1 ? "concern" : "concerns"}

      </p>
      <LibraryDrift sentence={libraryDrift} />
      {!finalised && !busy && <CvReviewControls key={`${assessment.inputHash}:${assessment.assessedAt}`} id={id} rows={rows} decision={decision} factualRowIds={factualRowIds} assessmentHash={assessment.inputHash} assessedAt={assessment.assessedAt} initialFindingId={initialFindingId} canFinalise={!overPages} />}
      <details className="border-t border-line-muted pt-3">
        <summary className="cursor-pointer text-14 font-medium">View full assessment</summary>
        <div className="mt-4 space-y-4">
      {quality && (
        <div className="space-y-3" aria-labelledby="cv-quality-title">
          <div>
            <h3 id="cv-quality-title" className="text-14 font-semibold">Quality checks</h3>
            <p className="text-12 text-muted">Separate checks show what the match score alone cannot.</p>
          </div>
          <dl className="grid gap-px border border-line-muted bg-line-muted sm:grid-cols-2 lg:grid-cols-4">
            <div className="bg-raised p-3">
              <dt className="ds-label">Factual support</dt>
              <dd className="mt-1 text-16 font-semibold">{quality.factualSupport.score === null ? "Not assessed" : `${quality.factualSupport.score}/100`}</dd>
              <dd className="text-12 text-muted">{quality.factualSupport.supported} of {quality.factualSupport.total} claims supported</dd>
            </div>
            <div className="bg-raised p-3">
              <dt className="ds-label">Priority coverage</dt>
              <dd className="mt-1 text-16 font-semibold">{quality.priorityCoverage.score === null ? "Not assessed" : `${quality.priorityCoverage.score}/100`}</dd>
              <dd className="text-12 text-muted">{quality.priorityCoverage.basis === "responsibilities_fallback" ? "Responsibility coverage; no essential or desirable priorities were stated" : "Capability evidence, weighted by role priority"}</dd>
            </div>
            <div className="bg-raised p-3">
              <dt className="ds-label">Evidence ready to use</dt>
              <dd className="mt-1 text-16 font-semibold">{quality.evidencedOpportunityGap.count}</dd>
              <dd className="text-12 text-muted">requirements with stronger evidence in Experience than this CV shows</dd>
            </div>
            <div className="bg-raised p-3">
              <dt className="ds-label">Logistics to confirm</dt>
              <dd className="mt-1 text-16 font-semibold">{quality.unverifiedLogistics.count}</dd>
              <dd className="text-12 text-muted">kept separate from capability coverage</dd>
            </div>
          </dl>
          <div className="border border-line-muted p-3 text-12">
            <p className="font-semibold">Editorial review</p>
            <p className="text-muted">{quality.editorial.disclaimer}</p>
            <ul className="mt-2 grid gap-2 sm:grid-cols-3">
              <li><strong>Repetition · {quality.editorial.repetition.label}</strong><span className="block text-muted">{quality.editorial.repetition.note}</span></li>
              <li><strong>Concision · {quality.editorial.concision.label}</strong><span className="block text-muted">{quality.editorial.concision.note}</span></li>
              <li><strong>Profile focus · {quality.editorial.summaryFocus.label}</strong><span className="block text-muted">{quality.editorial.summaryFocus.note}</span></li>
            </ul>
          </div>
        </div>
      )}
      <CvEvaluationTable rows={rows} />
        </div>
      </details>
      <div className="flex flex-wrap items-center gap-3 text-14">
        <a className="font-medium text-fg underline" href="/library">
          Open Experience
        </a>

      </div>
      {finalised ? (
        <p className="border border-ok p-3 text-14">
          {hasFinalPdf ? "Finalised. Download the saved PDF, or create a new revision to make changes." : "Finalised, but the saved PDF is unavailable. Create a new revision to make a downloadable document."}
        </p>
      ) : busy ? null : overPages ? (
        // Findings can be dismissed or explicitly overridden. Page overflow still needs a valid
        // layout, so explain that obstacle beside the review rather than offering a broken PDF.
        <div role="status" className="space-y-1 border border-warn p-3 text-14">
          {finaliseReason && (
            <p className="text-warn">Finalise is not available yet: {finaliseReason}</p>
          )}
          {overPages && (
            <p className={finaliseReason ? "" : "text-warn"}>
              This revision measures {assessment.pageCount}{" "}
              {assessment.pageCount === 1 ? "page" : "pages"}. Raise the page limit on the
              Appearance tab, or shorten the wording and save again.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
