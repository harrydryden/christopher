import type { CvContent } from "@christopher/core/cv";
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
}: {
  id: string;
  assessment: CvAssessment | null;
  current: boolean;
  finalised: boolean;
  busy: boolean;
  hasContent: boolean;
  content: CvContent | null;
}) {
  if (!assessment || !current)
    return (
      <section className="border border-warn p-4 space-y-3">
        <h2 className="font-semibold">Job match assessment</h2>
        <p className="text-14">
          {busy
            ? "Assessment pending"
            : "Assessment required"}
        </p>
        {!busy && !finalised && (
          <SettingsForm
            action={assessCvDraft.bind(null, id)}
            submitLabel={
              hasContent ? "Fit and assess saved revision" : "Retry generation"
            }
          >
            <></>
          </SettingsForm>
        )}
      </section>
    );
  const flagged = assessment.review.claims.filter(
    (claim) => claim.status !== "supported",
  );
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
          <h2 id="cv-match-title" className="font-semibold">
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
      {flagged.length > 0 && !finalised && (
        <p className="border border-warn p-3 text-14 text-warn">
          Resolve the Fact and Uncertain claims in the table, then save and
          reassess before finalising.
        </p>
      )}
      {finalised ? (
        <p className="border border-ok p-3 text-14">
          Finalised. Download this saved revision or create a new revision to
          make changes.
        </p>
      ) : !busy && !flagged.length && assessment.pageCount <= 2 ? (
        <SettingsForm
          action={finaliseCvDraft.bind(null, id)}
          submitLabel="Finalise this CV"
        >
          <label className="text-14">
            <input name="reviewed" type="checkbox" required /> I have reviewed
            the wording, score and evidence gaps for this revision.
          </label>
        </SettingsForm>
      ) : null}
    </section>
  );
}
