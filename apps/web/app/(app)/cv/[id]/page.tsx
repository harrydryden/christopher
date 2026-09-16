import { cvVersionLabel } from "@/lib/cv-version";
import { dailyCvVersions } from "@/lib/queries/cv";
import { CvDisclosure } from "@/components/CvDisclosure";
import { CvWorkspace, CvWorkspacePanel } from "@/components/CvWorkspace";
import { CvBuildProgress } from "@/components/CvBuildProgress";
import { CvAppearance } from "@/components/CvAppearance";
import { CvAssessmentPanel } from "@/components/CvAssessmentPanel";
import { cvAssessmentCurrent } from "@christopher/core/cv-review";
import { CvDraftEditor } from "@/components/CvDraftEditor";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { cvDrafts, applications } from "@christopher/db";
import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { zUuid } from "@/lib/validation";
import { recordApplication } from "@/app/actions/applications";
import { buttonClass } from "@/components/Button";
import { inputClass } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { SettingsForm } from "@/components/SettingsForm";
import { AutoRefresh } from "@/components/AutoRefresh";
export const dynamic = "force-dynamic";
export default async function CvDraftPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!zUuid().safeParse(id).success) notFound();
  const [draft] = await db().select().from(cvDrafts).where(eq(cvDrafts.id, id));
  if (!draft) notFound();
  const versions = await dailyCvVersions(db(), [draft.id]);
  const version = cvVersionLabel(draft.createdAt, versions.get(draft.id) ?? Math.max(1, draft.revision));
  const content = draft.content;
  const busy = draft.status === "queued" || draft.status === "generating";
  const current =
    !!content &&
    cvAssessmentCurrent(
      draft.assessment,
      content,
      draft.jobDescription,
      draft.librarySnapshot,
    );
  const [application] = await db()
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.cvId, id))
    .limit(1);
  return (
    <div className="w-full space-y-5">
      <nav aria-label="CV navigation">
        <Link
          href={draft.jobId ? `/cv?job=${draft.jobId}` : "/cv"}
          className="text-14 font-medium text-muted hover:text-fg hover:underline"
        >
          ← Back to CV builder
        </Link>
      </nav>
      <PageHeader
        title={`${draft.companyName} · ${draft.jobTitle}`}
        description={`Version ${version}`}
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
        {draft.status === "failed" && (
          <p
            role="alert"
            className="p-4 text-14 text-danger"
          >
            {draft.error}
          </p>
        )}
        {busy && (
          <AutoRefresh
            cvId={id}
            initialVersion={`${draft.status}:${draft.buildStage ?? ""}`}
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



              <Link href="/library" className="text-14 underline">
                Open Library
              </Link>
            </div>
          </CvWorkspacePanel>
        )}
        {(!content || busy) && (
          <CvWorkspacePanel tab="content">
            {busy && (
              <CvBuildProgress
                stage={draft.buildStage}
                queued={draft.status === "queued"}
              />
            )}
          </CvWorkspacePanel>
        )}
        {content && !busy ? (
          <CvDraftEditor
            key={id}
            id={id}
            content={content}
            tracking={
              <>
                <section className="space-y-3 border-2 border-line bg-raised p-4">
                  <CvDisclosure label="application tracking">
                    {application ? (
                      <Link href="/applications" className="underline">
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
            assessment={
              <CvAssessmentPanel
                id={id}
                assessment={draft.assessment}
                current={current}
                finalised={!!draft.finalisedAt}
                busy={busy}
                hasContent={!!content}
                content={content}
              />
            }
          />
        ) : (
          <CvWorkspacePanel tab="evaluation">
            <CvAssessmentPanel
              id={id}
              assessment={draft.assessment}
              current={current}
              finalised={!!draft.finalisedAt}
              busy={busy}
              hasContent={!!content}
              content={content}
            />
          </CvWorkspacePanel>
        )}
      </CvWorkspace>
    </div>
  );
}
