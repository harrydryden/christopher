import { cvMaxPages, type CvContent, type CvLibrary } from "@christopher/core/cv";
import type { CvAssessment } from "@christopher/core/cv-assessment";
import { diagnoseCvQuality } from "@christopher/core/cv-quality";
import { assessCvDraft, finaliseCvDraft } from "@/app/actions/cv";
import { cvEvaluationRows, type CvCommentInput } from "@/lib/cv-evaluation";
import { CvEvaluationTable } from "./CvEvaluationTable";
import { RebuildButton } from "./CvDraftEditor";
import { SettingsForm } from "./SettingsForm";

/**
 * The Library moved on after this revision was written, said where its evidence is judged.
 *
 * The control beside it is the editor's own Rebuild from Library, submitting the editor's form by
 * name: one rebuild in the product, offered in a second place rather than written twice. It is
 * absent when there is no editor on the page, because there is then nothing to rebuild from.
 */
function LibraryDrift({ sentence, formId }: { sentence: string | null; formId: string | null }) {
  if (!sentence) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 border border-warn p-3 text-14">
      <p className="text-warn">{sentence}</p>
      {formId && <RebuildButton form={formId} />}
    </div>
  );
}

export function CvAssessmentPanel({
  id,
  assessment,
  current,
  finalised,
  busy,
  hasContent,
  content,
  library = null,
  libraryDrift = null,
  rebuildFormId = null,
  finaliseReason = null,
  blocked = null,
  comments = [],
}: {
  id: string;
  assessment: CvAssessment | null;
  current: boolean;
  finalised: boolean;
  busy: boolean;
  hasContent: boolean;
  content: CvContent | null;
  /** This revision's own Library snapshot: what a gap row's "Add evidence" link is resolved against. */
  library?: Pick<CvLibrary, "entries"> | null;
  /** "Your Library changed since this build (v7 → v9).", or null while the build is up to date. */
  libraryDrift?: string | null;
  /** The editor form the Rebuild control submits, or null when this page has no editor. */
  rebuildFormId?: string | null;
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
}) {
  if (!assessment || !current)
    return (
      <section className="border border-warn p-4 space-y-3">
        <h2 className="ds-pixel text-12">Job match assessment</h2>
        <p className="text-14">
          {busy
            ? "Assessment pending"
            : "Assessment required"}
        </p>
        {!busy && finaliseReason && (
          <p className="text-14 text-warn">{finaliseReason}</p>
        )}
        <LibraryDrift sentence={libraryDrift} formId={rebuildFormId} />
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
          <h2 id="cv-match-title" className="ds-pixel text-12">
            CV evaluation
          </h2>
          <p className="text-14 text-muted">
            {assessment.pageCount}{" "}
            {assessment.pageCount === 1 ? "page" : "pages"}
          </p>
        </div>
        <div className="bg-accent px-4 py-3 text-accent-fg">
          <strong className="ds-pixel text-24">{assessment.score}/100</strong>
          <p className="text-12">CV match score</p>
        </div>
      </div>
      <p className="text-14 text-muted">
        Library evidence:{" "}
        <strong>{assessment.availableEvidenceScore}/100</strong>
        {" · "}
        {essentialGaps} essential requirements to review
        {" · "}
        {flagged.length} factual {flagged.length === 1 ? "concern" : "concerns"}

      </p>
      {quality && (
        <div className="space-y-3" aria-labelledby="cv-quality-title">
          <div>
            <h3 id="cv-quality-title" className="ds-pixel text-11">Quality checks</h3>
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
              <dd className="text-12 text-muted">requirements with stronger evidence in the Library than this CV shows</dd>
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
      <LibraryDrift sentence={libraryDrift} formId={rebuildFormId} />
      <CvEvaluationTable rows={rows} />
      <div className="flex flex-wrap items-center gap-3 text-14">
        <a className="font-medium text-fg underline" href="/library">
          Open Library
        </a>

      </div>
      {finalised ? (
        <p className="border border-ok p-3 text-14">
          Finalised. Download this saved revision or create a new revision to
          make changes.
        </p>
      ) : busy ? null : finaliseReason || overPages || flagged.length ? (
        // The three reasons `assertCvFinalisable` refuses on, said here rather than shown by the
        // absence of a button: the assessment is stale, the CV is over its page limit, or a claim
        // is still flagged. The sentence is the one that function would have thrown, computed on
        // the page; what the panel can see for itself keeps the control closed either way.
        <div role="status" className="space-y-1 border border-warn p-3 text-14">
          {finaliseReason && (
            <p className="text-warn">Finalise is not available yet: {finaliseReason}</p>
          )}
          {flagged.length > 0 && (
            <p className={finaliseReason ? "" : "text-warn"}>
              Resolve the Fact and Uncertain claims in the table, then save and reassess before
              finalising.
            </p>
          )}
          {overPages && (
            <p className={finaliseReason ? "" : "text-warn"}>
              This revision measures {assessment.pageCount}{" "}
              {assessment.pageCount === 1 ? "page" : "pages"}. Raise the page limit on the
              Appearance tab, or shorten the wording and save again.
            </p>
          )}
        </div>
      ) : (
        <SettingsForm
          action={finaliseCvDraft.bind(null, id)}
          submitLabel="Finalise this CV"
        >
          <label className="text-14">
            <input name="reviewed" type="checkbox" required /> I have reviewed
            the wording, score and evidence gaps for this revision.
          </label>
        </SettingsForm>
      )}
    </section>
  );
}
