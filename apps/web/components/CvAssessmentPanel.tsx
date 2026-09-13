import type { CvContent } from "@christopher/core/cv";
import type { CvAssessment } from "@christopher/core/cv-assessment";
import { assessCvDraft, finaliseCvDraft } from "@/app/actions/cv";
import { cvEvaluationRows } from "@/lib/cv-evaluation";
import { CvEvaluationTable } from "./CvEvaluationTable";
import { CvDisclosure } from "./CvDisclosure";
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
            ? "Your fitted CV will be checked and scored before it is ready for review."
            : "This revision needs an assessment before it can be finalised and downloaded."}
        </p>
        {!busy && !finalised && (
          <SettingsForm
            action={assessCvDraft.bind(null, id)}
            submitLabel={
              hasContent ? "Fit and assess saved revision" : "Retry generation"
            }
          >
            <p className="text-xs text-slate-500">
              Uses the saved company description and evidence snapshot. The
              selected CV model and normal AI budget apply.
            </p>
          </SettingsForm>
        )}
      </section>
    );
  const flagged = assessment.review.claims.filter(
    (claim) => claim.status !== "supported",
  );
  const rows = cvEvaluationRows(assessment, content);
  const essentialGaps = rows.filter(
    (row) => row.importance === "essential" && row.experience !== "Green",
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
            Assessment of this saved revision · {assessment.pageCount}{" "}
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
        . Our assessment, not an employer’s score or hiring probability.
      </p>
      <CvEvaluationTable rows={rows} />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <a className="font-medium text-accent underline" href="/cv/library">
          Add evidence to your library
        </a>
        <span className="text-xs text-slate-500">
          Use Improve with latest evidence for system suggestions. Edit wording
          in Content.
        </span>
      </div>
      <CvDisclosure label="assessment guide and method">
        <div className="space-y-2 text-xs leading-relaxed text-slate-600">
          <p>
            <strong>Change:</strong> None = no action; Fact = unsupported
            wording; Gap = additional evidence needed; Improvement = the system
            can use stronger saved evidence; Uncertain = clarification needed.
            Factual concerns must be resolved before finalising.
          </p>
          <p>
            <strong>Evidence:</strong> support in the saved library. None = no
            cited evidence; Weak = unclear support; Good = partial support;
            Strong = demonstrated. For standalone factual concerns, cited
            evidence remains Weak until the wording is confirmed.
          </p>
          <p>
            <strong>Experience:</strong> how well this CV meets the requirement.
            Green = demonstrated with supported wording; Amber = partial or
            uncertain; Red = missing or unsupported. Available library evidence
            can be Strong even when the CV needs improvement.
          </p>
          <p>
            Italic text is from the saved CV. Essential requirements carry twice
            the weight. Grounded full evidence earns full credit and partial
            evidence earns half; missing, unknown or unsupported wording earns
            none. Library coverage is a reference, not a promised score after
            rewriting.
          </p>
          {assessment.rubric.caveats.map((item, index) => (
            <p key={index}>{item}</p>
          ))}
          <p>
            Assessed {new Date(assessment.assessedAt).toLocaleString("en-GB")}{" "}
            using {assessment.model}. Method {assessment.version}. Source
            extracts are checked against saved inputs; semantic judgements are
            model estimates. Repeated keywords earn no extra points. Identity
            and decorative industry pills are excluded.
          </p>
          <p>
            Approach informed by{" "}
            <a
              className="underline"
              href="https://support.greenhouse.io/hc/en-us/articles/41131886674075-Talent-Matching-FAQ"
              target="_blank"
              rel="noopener noreferrer"
            >
              Greenhouse Talent Matching
            </a>{" "}
            and{" "}
            <a
              className="underline"
              href="https://help.workable.com/hc/en-us/articles/38381544828695-Using-the-Workable-Agent"
              target="_blank"
              rel="noopener noreferrer"
            >
              Workable’s screening criteria
            </a>
            . No CV is sent to those providers.
          </p>
        </div>
      </CvDisclosure>
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
