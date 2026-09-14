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
      <section className="rounded border border-amber-300 p-4 space-y-3">
        <h2 className="font-semibold">Job match assessment</h2>
        <p className="text-sm">
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
      className="space-y-4 rounded-lg border border-slate-200 p-4"
      aria-labelledby="cv-match-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="cv-match-title" className="font-semibold">
            CV evaluation
          </h2>
          <p className="text-sm text-slate-600">
            {assessment.pageCount}{" "}
            {assessment.pageCount === 1 ? "page" : "pages"}
          </p>
        </div>
        <div className="rounded bg-accent px-4 py-3 text-white">
          <strong className="text-2xl">{assessment.score}/100</strong>
          <p className="text-xs">CV match score</p>
        </div>
      </div>
      <p className="text-sm text-slate-600">
        Library evidence:{" "}
        <strong>{assessment.availableEvidenceScore}/100</strong>
        {" · "}
        {essentialGaps} essential requirements to review
        {" · "}
        {flagged.length} factual {flagged.length === 1 ? "concern" : "concerns"}

      </p>
      <CvEvaluationTable rows={rows} />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <a className="font-medium text-accent underline" href="/library">
          Open Library
        </a>

      </div>
      {flagged.length > 0 && !finalised && (
        <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Resolve the Fact and Uncertain claims in the table, then save and
          reassess before finalising.
        </p>
      )}
      {finalised ? (
        <p className="rounded border border-emerald-300 p-3 text-sm">
          Finalised. Download this saved revision or create a new revision to
          make changes.
        </p>
      ) : !busy && !flagged.length && assessment.pageCount <= 2 ? (
        <SettingsForm
          action={finaliseCvDraft.bind(null, id)}
          submitLabel="Finalise this CV"
        >
          <label className="text-sm">
            <input name="reviewed" type="checkbox" required /> I have reviewed
            the wording, score and evidence gaps for this revision.
          </label>
        </SettingsForm>
      ) : null}
    </section>
  );
}
