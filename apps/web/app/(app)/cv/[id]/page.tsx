import { cvVersionLabel } from "@/lib/cv-version";
import { VERIFY_SENTENCE } from "@/components/VerifyNotice";
import { dailyCvVersions, getOwnCvBuildSteps, getOwnCvBuildTask, getOwnCvDraft } from "@/lib/queries/cv";
import { cvBuildState, cvStepsSignature, cvWorkVersion } from "@/lib/cv-build-state";
import { cvDraftSize, cvEditCosts } from "@/lib/cv-quote";
import { CvDisclosure } from "@/components/CvDisclosure";
import { CvWorkspace, CvWorkspacePanel } from "@/components/CvWorkspace";
import { CvBuildProgress } from "@/components/CvBuildProgress";
import { CvGapQuiz } from "@/components/CvGapQuiz";
import { answerCvGapQuiz } from "@/app/actions/cv";
import { CvBuildLog, CvBuildNarrative } from "@/components/CvBuildNarrative";
import { cvBuildTotals, cvBuildTotalsLine } from "@/lib/cv-build-narrative";
import { CvBuildFailureNotice } from "@/components/CvBuildFailureNotice";
import { getSystemSettings } from "@/lib/settings";
import { CvAppearance } from "@/components/CvAppearance";
import { CvAssessmentPanel } from "@/components/CvAssessmentPanel";
import { CvShareCard } from "@/components/CvShareCard";
import { CvShareComments } from "@/components/CvShareComments";
import { getOwnCvSharing } from "@/lib/queries/cv-shares";
import { openCommentCounts } from "@/lib/cv-share";
import { assertCvFinalisable, cvAssessmentCurrent } from "@ava/core/cv-review";
import type { CvContent, CvLibrary } from "@ava/core/cv";
import type { CvAssessment } from "@ava/core/cv-assessment";
import { CvDraftEditor } from "@/components/CvDraftEditor";
import { cvEditFormId } from "@/lib/cv-content-links";
import { libraryDriftSentence } from "@/lib/cv-evaluation";
import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { applications, cvLibraries } from "@ava/db";
import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { zUuid } from "@/lib/validation";
import { recordApplication } from "@/app/actions/applications";
import { buttonClass } from "@/components/Button";
import { inputClass } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { SettingsForm } from "@/components/SettingsForm";
import { AutoRefresh } from "@/components/AutoRefresh";
import { isAdmin, needsEmailConfirmation, requireUser } from "@/lib/auth";

/**
 * Why the actions that spend money are unavailable to an unverified account, in the sentence the
 * banner above the page already uses. `requireVerifiedUser()` refuses these actions anyway; saying
 * so at the control is what stops a revision being typed before the wall is discovered.
 */

/**
 * Why Finalise is unavailable, in the words `assertCvFinalisable` would have thrown, or null when
 * nothing is in the way. The same function the action, the download route and `recordApplication`
 * all re-run, so the page and the three gates can never disagree about this revision.
 */
function finaliseObstacle(draft: {
  content: CvContent | null;
  jobDescription: string;
  librarySnapshot: CvLibrary;
  assessment: CvAssessment | null;
}): string | null {
  if (!draft.content) return null;
  try {
    assertCvFinalisable({ ...draft, content: draft.content });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "This CV cannot be finalised yet.";
  }
}
export const dynamic = "force-dynamic";
export default async function CvDraftPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  if (!zUuid().safeParse(id).success) notFound();
  const draft = await getOwnCvDraft(user.id, id);
  if (!draft) notFound();
  const versions = await dailyCvVersions(db(), [draft.id]);
  const version = cvVersionLabel(draft.createdAt, versions.get(draft.id) ?? Math.max(1, draft.revision));
  const content = draft.content;
  const busy = draft.status === "queued" || draft.status === "generating";
  const awaitingEvidence = draft.status === "awaiting_evidence";
  const failed = draft.status === "failed";
  // A build that has stopped moving is indistinguishable from a slow one without the queue row
  // behind it: which attempt this is, whether anything still holds it, and what the last one left.
  const now = new Date();
  const [buildTask, steps, system, admin, latestLibrary, sharing] = await Promise.all([
    busy || failed ? getOwnCvBuildTask(user.id, id) : null,
    // The ledger of motions: the narrative while it builds, the build log afterwards.
    getOwnCvBuildSteps(user.id, id),
    getSystemSettings(),
    isAdmin(),
    // This account's newest Library version, so the panel can say when the evidence behind this
    // revision has moved on. The content is not read: only the number the two are compared by.
    db()
      .select({ version: cvLibraries.version })
      .from(cvLibraries)
      .where(eq(cvLibraries.userId, user.id))
      .orderBy(desc(cvLibraries.version))
      .limit(1),
    // The links this account has opened onto this revision, and the notes left through them.
    // Both are scoped by the account and the draft, as every per-account read is.
    getOwnCvSharing(user.id, id),
  ]);
  const build = busy || failed ? cvBuildState(draft, buildTask, now, system.timezone) : null;
  const narrativeContext = { timeZone: system.timezone, versionLabel: version };
  const maxAttempts = build?.maxAttempts ?? null;
  const current =
    !!content &&
    cvAssessmentCurrent(
      draft.assessment,
      content,
      draft.jobDescription,
      draft.librarySnapshot,
    );
  // Work that calls a model is held back until the address is confirmed, so the controls that ask
  // for one say why rather than refusing after the wording has been typed.
  const blocked = needsEmailConfirmation(user) ? VERIFY_SENTENCE : null;
  const finaliseReason = finaliseObstacle(draft);
  // What the whole build came to, once there is nothing left running to change it.
  const totals = !busy && steps.length ? cvBuildTotalsLine(cvBuildTotals(steps, now)) : null;
  // The Library this revision was written from, and what has been saved over it since: the
  // sentence is only offered where there is an editor to rebuild from.
  const drift = libraryDriftSentence(draft.libraryVersion, latestLibrary[0]?.version);
  // What a reader said, where the reviewer's findings are read. Notes never change a rating; they
  // become their own rows, and a count beside the block they are about.
  const commentCounts = openCommentCounts(sharing.comments);
  // The same panel whichever tab holds it: one set of props, written once.
  const assessment = (
    <>
      <CvAssessmentPanel
        id={id}
        assessment={draft.assessment}
        current={current}
        finalised={!!draft.finalisedAt}
        busy={busy}
        hasContent={!!content}
        content={content}
        library={draft.librarySnapshot}
        libraryDrift={drift}
        rebuildFormId={content && !busy && !blocked ? cvEditFormId(id) : null}
        finaliseReason={finaliseReason}
        blocked={blocked}
        comments={sharing.comments}
      />
      <CvShareComments
        draftId={id}
        comments={sharing.comments}
        openCount={sharing.openCount}
        content={content}
        now={now}
      />
    </>
  );
  const [application] = await db()
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.cvId, id), eq(applications.userId, user.id)))
    .limit(1);
  return (
    <div className="w-full space-y-5">
      <nav aria-label="CV navigation">
        <Link prefetch={false}
          href={draft.jobId ? `/applications?job=${draft.jobId}` : "/applications"}
          className="text-14 font-medium text-muted hover:text-fg hover:underline"
        >
          ← Back to Applications
        </Link>
      </nav>
      <PageHeader
        title={`${draft.companyName} · ${draft.jobTitle}`}
        description={
          <>
            Version {version}
            {/* What this revision cost, beside its name, rather than only inside the build log. */}
            {totals && <> · {totals}</>}
          </>
        }
        actions={
          content &&
          !busy && (
            <>
              <a
                href={`/api/cv/${id}/pdf?preview=1`}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonClass("secondary", "md", "no-underline")}
              >
                Preview PDF
              </a>
              {draft.finalisedAt && (
                <a
                  href={`/api/cv/${id}/pdf`}
                  className={buttonClass("primary", "md", "no-underline")}
                >
                  Download PDF
                </a>
              )}
            </>
          )
        }
      />
      <CvWorkspace
        description={
          <>
            <p className="text-12 text-muted">
              The saved company advert used to write and assess this CV.
            </p>
            <p className="whitespace-pre-wrap text-14 leading-relaxed">
              {draft.jobDescription}
            </p>
            <CvDisclosure label="source and evidence details">
              <p className="my-2 text-14">
                <a className="underline" href="/library">
                  Open Library
                </a>{" "}
                · This description is the exact snapshot used for writing and
                scoring.{" "}
                {(!draft.jobSource || draft.jobSource.method === "unknown") &&
                  "Extraction provenance was not recorded for this older description; compare it with the full company advert before relying on the score."}{" "}
                {draft.jobSource?.kind === "user_supplied"
                  ? "It was supplied by you; verify it matches the company’s full advert."
                  : "It was saved from the company role record."}{" "}
                {draft.jobSource?.url && (
                  <a
                    className="underline"
                    href={draft.jobSource.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open original role
                  </a>
                )}
              </p>
            </CvDisclosure>
          </>
        }
      >
        {failed && build && (
          // What stopped this build, and the one thing that will make the next attempt different.
          <CvBuildFailureNotice
            id={id}
            build={build}
            jobId={draft.jobId}
            admin={admin}
            canRetry={!draft.finalisedAt}
            blocked={blocked}
            footnote={`Retry or edit this attempt now. Only the newest failed attempt for a company and role is kept, so the next revision you start for ${draft.jobTitle} replaces it, and a revision that builds successfully removes it.`}
          />
        )}
        {busy && (
          // The ledger is already read above; its signature is derived from those rows rather than
          // asked of the database a second time.
          <AutoRefresh
            cvId={id}
            initialVersion={cvWorkVersion(draft, now, cvStepsSignature(steps))}
            message={null}
          />
        )}
        {(!content || busy) && (
          <CvWorkspacePanel tab="appearance">
            <h2 className="ds-pixel text-12">Appearance and CV settings</h2>
            <div className="mt-4 space-y-3">
              <fieldset disabled>
                <CvAppearance
                  value={content?.theme ?? draft.librarySnapshot.theme}
                />
              </fieldset>



              <Link prefetch={false} href="/library" className="text-14 underline">
                Open Library
              </Link>
            </div>
          </CvWorkspacePanel>
        )}
        {(!content || busy) && (
          <CvWorkspacePanel tab="content">
            {awaitingEvidence && draft.gapQuiz?.status === "awaiting_answers" && (
              <CvGapQuiz
                quiz={draft.gapQuiz}
                library={draft.librarySnapshot}
                action={answerCvGapQuiz.bind(null, id)}
              />
            )}
            {draft.gapQuiz?.continuationDraftId && (
              <p className="border border-line-muted p-4 text-14">
                Your answers were saved to the Library. <Link prefetch={false} className="underline" href={`/cv/${draft.gapQuiz.continuationDraftId}`}>Open the continuing CV build</Link>.
              </p>
            )}
            {busy && build && (
              <CvBuildProgress
                stage={draft.buildStage}
                queued={draft.status === "queued"}
                build={build}
                startedAt={draft.createdAt}
                now={now}
                narrative={
                  <CvBuildNarrative
                    steps={steps}
                    now={now}
                    maxAttempts={maxAttempts}
                    context={narrativeContext}
                  />
                }
                action={
                  build.phase === "stopped" ? (
                    <p className="text-14 text-muted">
                      Nothing is working on this build. It is retried automatically while attempts
                      remain; once the worker gives up, this page offers Retry generation and your
                      saved wording, if any, stays editable.
                    </p>
                  ) : undefined
                }
              />
            )}
            {!busy && (
              <CvBuildLog steps={steps} now={now} maxAttempts={maxAttempts} context={narrativeContext} />
            )}
          </CvWorkspacePanel>
        )}
        {content && !busy ? (
          <CvDraftEditor
            key={id}
            id={id}
            content={content}
            // What each of the two saves is expected to cost, measured on this revision's own
            // evidence and advert with the estimator the worker admits builds against.
            costs={cvEditCosts(draft.model, cvDraftSize(draft))}
            blocked={blocked}
            commentCounts={commentCounts}
            // A link is of a finished, assessed revision (the action refuses anything else), so the
            // card is offered only then — or kept where links already exist, so they can be ended.
            share={(draft.status === "ready" && draft.assessment) || sharing.shares.length > 0 ? <CvShareCard draftId={id} shares={sharing.shares} now={now} /> : undefined}
            buildLog={
              <CvBuildLog steps={steps} now={now} maxAttempts={maxAttempts} context={narrativeContext} />
            }
            tracking={
              <>
                <section className="space-y-3 border-2 border-line bg-raised p-4">
                  <CvDisclosure label="application tracking">
                    {application ? (
                      <Link prefetch={false} href={draft.jobId ? `/applications?job=${draft.jobId}` : "/applications"} className="underline">
                        Application recorded — view status and frozen PDF
                      </Link>
                    ) : !draft.finalisedAt ? (
                      <p className="text-14">
                        Finalise the assessed CV before recording an
                        application.
                      </p>
                    ) : (
                      <SettingsForm
                        action={recordApplication.bind(null, id)}
                        submitLabel="Record application with this saved CV"
                      >
                        <p className="text-14">
                          Use this after submitting this CV revision. This
                          records your application; it does not send anything to
                          the employer.
                        </p>
                        <label className="flex flex-col gap-1.5 text-14">
                          Application date
                          <input
                            type="date"
                            name="appliedOn"
                            required
                            className={`max-w-xs ${inputClass}`}
                          />
                        </label>
                        <label className="flex flex-col gap-1.5 text-14">
                          Notes
                          <textarea
                            name="notes"
                            maxLength={4000}
                            rows={3}
                            className={`resize-y ${inputClass}`}
                          />
                        </label>
                      </SettingsForm>
                    )}
                  </CvDisclosure>
                </section>
              </>
            }
            assessment={assessment}
          />
        ) : (
          <CvWorkspacePanel tab="evaluation">{assessment}</CvWorkspacePanel>
        )}
      </CvWorkspace>
    </div>
  );
}
