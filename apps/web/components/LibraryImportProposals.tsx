import { Card } from "@/components/Card";
import { Checkbox } from "@/components/Field";
import { LibraryImportForm } from "@/components/LibraryImportForm";
import { acceptLibraryImport, dismissLibraryImport, retryLibraryImport } from "@/app/actions/library-import";
import { proposedDates, type LibraryImportView } from "@/lib/library-import";

/**
 * What came of each document, and the controls that decide what happens to it.
 *
 * Every item starts ticked, because the extraction has already dropped everything the document
 * did not support and what is left is the person's own words: the work in front of them is
 * removing the two rows they no longer want to claim, not confirming the fifteen they wrote.
 *
 * A responsibility sits under the job it belongs to and is added only with it — a library cannot
 * carry evidence for an employer it does not list — which is why unticking a job dims its rows.
 */
export function LibraryImportProposals({ imports, version }: { imports: LibraryImportView[]; version: number }) {
  if (!imports.length) return null;
  return (
    <div className="grid gap-5">
      {imports.map(view => (
        <Card key={view.id} title={view.headline}>
          {view.state === "reading" && !view.stalled && (
            <p role="status" className="text-14 text-muted">
              Reading your document… This usually takes a minute or two. You can carry on editing below.
            </p>
          )}

          {/* Long past the point where anything could still be running. Nothing but the handler
              ever moves this row on, so the card stops implying one is coming and offers the way
              out — without which the document sits here for ever and its own fingerprint refuses
              the same upload again. */}
          {view.state === "reading" && view.stalled && (
            <div className="grid gap-3">
              <p role="status" className="text-14 text-warn">
                This document has been waiting to be read for a while. Christopher will still read it
                if it comes back to it; dismiss it if you would rather import it again.
              </p>
              <LibraryImportForm
                action={dismissLibraryImport.bind(null, view.id)}
                submitLabel="Dismiss"
                pendingLabel="Dismissing…"
                className="contents"
                variant="ghost"
              />
            </div>
          )}

          {view.state === "failed" && (
            <div className="grid gap-3">
              <p role="alert" className="text-14 text-warn">{view.error}</p>
              <div className="flex flex-wrap items-center gap-3">
                {view.retryable && (
                  <LibraryImportForm
                    action={retryLibraryImport.bind(null, view.id)}
                    submitLabel="Try again"
                    pendingLabel="Queuing…"
                    className="contents"
                    variant="secondary"
                  />
                )}
                <LibraryImportForm
                  action={dismissLibraryImport.bind(null, view.id)}
                  submitLabel="Dismiss"
                  pendingLabel="Dismissing…"
                  className="contents"
                  variant="ghost"
                />
              </div>
            </div>
          )}

          {view.state === "proposed" && view.proposal && (
            <div className="grid gap-4">
              <p className="text-14 text-muted">
                Tick what is yours. They arrive with their rows unconfirmed; confirm the ones you
                have checked.
              </p>

              <LibraryImportForm
                action={acceptLibraryImport.bind(null, view.id)}
                submitLabel="Add the selected items"
                pendingLabel="Adding…"
                className="grid gap-4"
              >
                <input type="hidden" name="version" value={version} />

                {view.proposal.employment.map(job => (
                  <fieldset key={job.id} className="grid gap-2 border-2 border-line-muted p-3">
                    <legend className="sr-only">{job.title}, {job.company}</legend>
                    <Checkbox
                      name="accept"
                      value={job.id}
                      defaultChecked
                      label={
                        <span className="text-14">
                          <span className="font-semibold">{job.title}</span> · {job.company}
                          {proposedDates(job) && <span className="text-muted"> · {proposedDates(job)}</span>}
                          {!proposedDates(job) && <span className="text-faint"> · no dates in the document</span>}
                        </span>
                      }
                    />
                    {job.responsibilities.length > 0 && (
                      <ul className="grid gap-1.5 pl-6">
                        {job.responsibilities.map(row => (
                          <li key={row.id}>
                            <Checkbox name="accept" value={row.id} defaultChecked label={<span className="text-14">{row.text}</span>} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </fieldset>
                ))}

                {view.proposal.education.length > 0 && (
                  <fieldset className="grid gap-2 border-2 border-line-muted p-3">
                    <legend className="ds-label px-1">Qualifications</legend>
                    {view.proposal.education.map(item => (
                      <Checkbox
                        key={item.id}
                        name="accept"
                        value={item.id}
                        defaultChecked
                        label={<span className="text-14"><span className="font-semibold">{item.heading}</span> · {item.detail}</span>}
                      />
                    ))}
                  </fieldset>
                )}

                {view.proposal.skills.length > 0 && (
                  <fieldset className="grid gap-2 border-2 border-line-muted p-3">
                    <legend className="ds-label px-1">Skills</legend>
                    <div className="flex flex-wrap gap-x-5 gap-y-2">
                      {view.proposal.skills.map(item => (
                        <Checkbox key={item.id} name="accept" value={item.id} defaultChecked label={<span className="text-14">{item.text}</span>} />
                      ))}
                    </div>
                  </fieldset>
                )}
              </LibraryImportForm>

              <LibraryImportForm
                action={dismissLibraryImport.bind(null, view.id)}
                submitLabel="Dismiss"
                pendingLabel="Dismissing…"
                className="contents"
                variant="ghost"
                confirm="Dismiss this import? Nothing will be added to your Library."
              />
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
