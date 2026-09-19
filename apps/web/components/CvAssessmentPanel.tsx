import { cvMaxPages, type CvContent } from "@christopher/core/cv";
import type { CvAssessment } from "@christopher/core/cv-assessment";
import { assessCvDraft, finaliseCvDraft } from "@/app/actions/cv";
import { cvEvaluationRows } from "@/lib/cv-evaluation";
import { CvEvaluationTable } from "./CvEvaluationTable";
import { SettingsForm } from "./SettingsForm";

export function CvAssessmentPanel({
  id,
  assessment,
  current,
  finalised,
  busy,
  hasContent,
  content,
  finaliseReason = null,
  blocked = null,
}: {
  id: string;
  assessment: CvAssessment | null;
  current: boolean;
  finalised: boolean;
  busy: boolean;
  hasContent: boolean;
  content: CvContent | null;
  /**
   * Why this revision cannot be finalised, in the sentence `assertCvFinalisable` would throw, or
   * null when it can be. Computed on the page with the same function the action re-runs, so the
   * control's absence is explained rather than silent.
   */
  finaliseReason?: string | null;
  /** Why assessing is unavailable — an unverified account — or null when it is not. */
  blocked?: string | null;
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
  const rows = cvEvaluationRows(assessment, content);
  const essentialGaps = rows.filter(
    (row) => row.importance === "essential" && row.experience !== "Strong",
  ).length;
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
