import type { CvContent } from "@christopher/core/cv";
import { cvClaimItems } from "@christopher/core/cv-assessment";
import Link from "next/link";
import type { CvAssessment } from "@christopher/core/cv-assessment";
import {
  cvImprovementOwner,
  cvRequirementWeight,
} from "@christopher/core/cv-assessment";
import { assessCvDraft, finaliseCvDraft } from "@/app/actions/cv";
import { SettingsForm } from "./SettingsForm";

const labels = {
  demonstrated: "Demonstrated",
  partial: "Partly demonstrated",
  missing: "Not evidenced",
  unknown: "Needs clarification",
};
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
            ? "The worker is preparing an assessment of this revision."
            : "This revision needs an assessment before it can be finalised and downloaded."}
        </p>
        {!busy && !finalised && (
          <SettingsForm
            action={assessCvDraft.bind(null, id)}
            submitLabel={
              hasContent ? "Assess saved revision" : "Retry generation"
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
  const systems = assessment.review.matches.filter(
    (match) => cvImprovementOwner(match) === "system",
  );
  const user = assessment.review.matches.filter(
    (match) => cvImprovementOwner(match) === "user",
  );
  const essentialGaps = assessment.rubric.requirements.filter(
    (requirement) =>
      requirement.importance === "essential" &&
      assessment.review.matches.find(
        (match) => match.requirementId === requirement.id,
      )?.status !== "demonstrated",
  );
  const actions = (items: typeof systems) => (
    <ul className="space-y-2 text-sm">
      {items.map((match) => (
        <li key={match.requirementId}>
          <strong>
            {
              assessment.rubric.requirements.find(
                (item) => item.id === match.requirementId,
              )?.label
            }
          </strong>
          <p>{match.improvement || match.reason}</p>
        </li>
      ))}
    </ul>
  );
  return (
    <section
      className="space-y-4 rounded-lg border border-slate-200 p-4"
      aria-labelledby="cv-match-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="cv-match-title" className="font-semibold">
            CV match against the company’s job description
          </h2>
          <p className="text-sm text-slate-600">
            Assessment of this saved revision · {assessment.pageCount}{" "}
            {assessment.pageCount === 1 ? "page" : "pages"}
          </p>
        </div>
        <div className="rounded bg-accent px-4 py-3 text-white">
          <strong className="text-2xl">{assessment.score}/100</strong>
          <p className="text-xs">Evidence-backed coverage</p>
        </div>
      </div>
      <p className="text-sm">
        Essential requirements carry twice the weight. Full evidence earns full
        credit; partial evidence earns half. Missing or unknown evidence earns
        no credit. This is our assessment of the published description;
        employers may use different criteria. It is not a hiring probability.
      </p>
      <p className="text-sm">
        The saved evidence library covers{" "}
        <strong>{assessment.availableEvidenceScore}/100</strong> on the same
        criteria. This is an evidence reference, not a promised score after
        rewriting.
      </p>
      {essentialGaps.length > 0 && (
        <p className="rounded border border-amber-300 p-3 text-sm">
          {essentialGaps.length} essential{" "}
          {essentialGaps.length === 1
            ? "requirement needs"
            : "requirements need"}{" "}
          stronger evidence or clarification. A high overall score does not
          remove these gaps.
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <h3 className="font-semibold">The system can improve</h3>
          {systems.length ? (
            actions(systems)
          ) : (
            <p className="text-sm">
              No stronger omitted evidence was identified in this snapshot.
            </p>
          )}
          <p className="text-xs text-slate-600">
            Use Improve with latest evidence below to author and assess a new
            revision. Every suggestion remains subject to factual and two-page
            checks.
          </p>
        </div>
        <div className="space-y-2">
          <h3 className="font-semibold">Evidence you need to provide</h3>
          {user.length ? (
            actions(user)
          ) : (
            <p className="text-sm">
              No additional evidence questions were identified.
            </p>
          )}
          <Link className="text-sm underline" href="/cv/library">
            Add and confirm evidence in your library
          </Link>
        </div>
      </div>
      <details>
        <summary className="cursor-pointer font-medium">
          Requirement-by-requirement evidence (
          {assessment.rubric.requirements.length})
        </summary>
        <ol className="mt-3 space-y-4">
          {assessment.rubric.requirements.map((requirement) => {
            const match = assessment.review.matches.find(
              (item) => item.requirementId === requirement.id,
            )!;
            return (
              <li
                key={requirement.id}
                className="rounded border border-slate-200 p-3 text-sm"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <strong>{requirement.label}</strong>
                  <span>
                    {labels[match.status]} · weight{" "}
                    {cvRequirementWeight(requirement)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-600">
                  {requirement.importance} · {requirement.category}
                </p>
                <blockquote className="my-2 border-l-2 border-accent pl-3">
                  {requirement.quote}
                </blockquote>
                <p>{match.reason}</p>
                {match.cvEvidence.map((ref, index) => (
                  <p key={index} className="mt-2">
                    <strong>CV:</strong> “{ref.quote}”
                  </p>
                ))}
                {match.libraryEvidence.map((ref, index) => (
                  <p key={index} className="mt-2">
                    <strong>Confirmed evidence:</strong> “{ref.quote}”
                  </p>
                ))}
              </li>
            );
          })}
        </ol>
      </details>
      <section className="space-y-2">
        <h3 className="font-semibold">Factual review</h3>
        {flagged.length ? (
          <>
            <p className="text-sm">
              Resolve these claims before finalising. Edit the wording or
              provide supporting evidence, then reassess.
            </p>
            <ul className="space-y-2 text-sm">
              {flagged.map((claim) => (
                <li
                  key={claim.claimId}
                  className="rounded border border-amber-300 p-3"
                >
                  <strong>
                    {claim.status === "unsupported"
                      ? "Unsupported"
                      : "Uncertain"}{" "}
                    claim
                  </strong>
                  <blockquote className="my-2 border-l-2 border-amber-400 pl-3">
                    {content &&
                      cvClaimItems(content).find(
                        (item) => item.id === claim.claimId,
                      )?.text}
                  </blockquote>
                  <p>{claim.reason}</p>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm">
            Every printed claim was reviewed against the evidence snapshot. Read
            the CV yourself to confirm factual accuracy.
          </p>
        )}
      </section>
      {!!assessment.rubric.caveats.length && (
        <ul className="list-disc pl-5 text-sm">
          {assessment.rubric.caveats.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      )}
      <details className="text-xs text-slate-600">
        <summary>Assessment method and provenance</summary>
        <p className="mt-2">
          Assessed {new Date(assessment.assessedAt).toLocaleString("en-GB")}{" "}
          using {assessment.model}. Method {assessment.version}. Quotes are
          checked against the saved inputs; semantic judgements are model
          estimates. Repeated keywords earn no extra points. Name, contact
          details and decorative industry pills are excluded from scoring.
        </p>
        <p className="mt-2">
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
      </details>
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
