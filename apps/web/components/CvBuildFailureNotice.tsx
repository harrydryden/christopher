import Link from "next/link";
import { assessCvDraft } from "@/app/actions/cv";
import { buttonClass } from "./Button";
import { SettingsForm } from "./SettingsForm";
import { failureWayForward, type CvBuildState } from "@/lib/cv-build-state";

/**
 * What stopped a build, and the one thing that will make the next attempt different.
 *
 * A failure the system resolves never reaches this: the queue is already holding the next attempt
 * and the progress header says so. This is for the failures that are waiting on a person — a
 * budget to raise, a Library to fix, a description to paste — and for the ones the system tried
 * three times and could not get past, where the way forward is the retry itself.
 *
 * Every control here is one that would work: the retry is `assessCvDraft`, which refuses a draft
 * that is finalised or still building, so `canRetry` is checked before it is rendered rather than
 * offering a button that always errors.
 */
export function CvBuildFailureNotice({
  id,
  build,
  jobId,
  admin,
  canRetry,
  footnote,
}: {
  id: string;
  build: CvBuildState;
  jobId: string | null;
  admin: boolean;
  canRetry: boolean;
  /** What the page already said about this draft's place in the table. */
  footnote?: string;
}) {
  const way = failureWayForward(build.action, { jobId, admin, canRetry });
  return (
    <div role="alert" className="space-y-3 border-2 border-danger p-4">
      <div className="space-y-1">
        <h2 className="ds-pixel text-12 text-danger">{build.title ?? "This build failed"}</h2>
        <p className="text-14">{build.message}</p>
        {way.note && <p className="text-14">{way.note}</p>}
        {build.resumeNote && <p className="text-12 text-muted">{build.resumeNote}</p>}
        {build.taskError && build.taskError !== build.message && (
          <p className="text-12 text-muted" title={build.taskError}>
            The queue recorded: {build.taskError}
          </p>
        )}
      </div>
      {way.links.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {way.links.map((link) => (
            <Link key={link.href} href={link.href} className={buttonClass("secondary", "md", "no-underline")}>
              {link.label}
            </Link>
          ))}
        </div>
      )}
      {way.retry && (
        <div className="space-y-2">
          {way.retryNote && <p className="text-14 text-muted">{way.retryNote}</p>}
          <SettingsForm action={assessCvDraft.bind(null, id)} submitLabel="Retry generation">
            <></>
          </SettingsForm>
        </div>
      )}
      {footnote && <p className="text-14 text-muted">{footnote}</p>}
    </div>
  );
}
