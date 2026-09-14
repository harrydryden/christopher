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
          className="text-sm font-medium text-slate-600 hover:text-slate-900 hover:underline"
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
                className="inline-flex items-center justify-center rounded-md border border-white/60 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-white/10"
              >
                Preview PDF
              </a>
              {draft.finalisedAt && (
                <a
                  href={`/api/cv/${id}/pdf`}
                  className="inline-flex items-center justify-center rounded-md bg-white px-3 py-1.5 text-sm font-medium text-accent transition-colors hover:bg-slate-100"
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
            <p className="text-xs text-slate-500">
              The saved company advert used to write and assess this CV.
            </p>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">
              {draft.jobDescription}
            </p>
            <CvDisclosure label="source and evidence details">
              <p className="my-2 text-sm">
                <a className="underline" href="/cv/library">
                  Open evidence library
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
            className="rounded bg-red-50 p-4 text-sm text-red-700"
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
            <h2 className="font-semibold">Appearance and CV settings</h2>
            <div className="mt-4 space-y-3">
              <fieldset disabled>
                <CvAppearance
                  value={content?.theme ?? draft.librarySnapshot.theme}
                />
              </fieldset>
              <p className="text-sm">
                Two-page maximum · Up to six bullets per section · 650
                characters per bullet.
              </p>
              <p className="text-sm text-slate-600">
                Settings are saved for this build. You can change them when it
                finishes.
              </p>
              <p className="text-xs text-slate-500">
                Evidence version {draft.libraryVersion} · {draft.model}
              </p>
              <Link href="/cv/library" className="text-sm underline">
                Open evidence library
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
                <section className="rounded border p-4 space-y-3">
                  <CvDisclosure label="application tracking">
                    {application ? (
                      <Link href="/applications" className="underline">
                        Application recorded — view status and frozen PDF
                      </Link>
                    ) : !draft.finalisedAt ? (
                      <p className="text-sm">
                        Finalise the assessed CV before recording an
                        application.
                      </p>
                    ) : (
                      <SettingsForm
                        action={recordApplication.bind(null, id)}
                        submitLabel="Record application with this saved CV"
                      >
                        <p className="text-sm">
                          Use this after submitting this CV revision. This
                          records your application; it does not send anything to
                          the employer.
                        </p>
                        <label>
                          Application date
                          <input
                            type="date"
                            name="appliedOn"
                            required
                            className="ml-2 rounded border p-2"
                          />
                        </label>
                        <label>
                          Notes
                          <textarea
                            name="notes"
                            maxLength={4000}
                            className="block w-full rounded border p-2"
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
