import type { PreferenceProfile } from "@col/db/schema";
import { diffLines, displayDiff, pinnedLines, questionLines, textLines, type DisplayLine } from "@/lib/profile-version-diff";

export type ComparedProfile = Pick<PreferenceProfile, "version" | "markdown" | "pinnedStatements" | "openQuestions">;

function SectionDiff({ title, rows, added, removed, identityChanged = false, truncated, before, after, previousVersion, currentVersion }: {
  title: string;
  rows: DisplayLine[];
  added: number;
  removed: number;
  truncated: boolean;
  before: string[];
  after: string[];
  previousVersion: number;
  currentVersion: number;
  identityChanged?: boolean;
}) {
  return <section className="min-w-0 space-y-2">
    <h4 className="text-14 font-semibold">{title}</h4>
    {identityChanged && <p className="text-13 text-muted">A question record changed, even though its wording or answer may look the same.</p>}
    {!added && !removed ? <p className="text-13 text-muted">{identityChanged ? "No wording or answer changes in this section." : "No changes in this section."}</p> : <>
      <p className="text-12 text-muted">{added} added · {removed} removed</p>
      <ol aria-label={`${title} changes`} className="min-w-0 space-y-1">
        {rows.map((row, index) => row.kind === "omitted"
          ? <li key={index} className="text-12 text-muted">{row.count} comparison {row.count === 1 ? "group" : "groups"} omitted</li>
          : <li key={index} className={`flex min-w-0 gap-2 border-l-2 px-2 py-1 ${row.kind === "added" ? "border-success bg-success/10" : row.kind === "removed" ? "border-danger bg-danger/10" : "border-line-muted"}`}>
            <span className="w-16 shrink-0 text-12 font-semibold">{row.kind === "added" ? "Added" : row.kind === "removed" ? "Removed" : "Context"}</span>
            <span className="min-w-0 break-all whitespace-pre-wrap font-mono text-12">{row.lines.map(line => line === "" ? "(blank line)" : line).join("\n")}</span>
          </li>)}
      </ol>
      {truncated && <details className="min-w-0 border-l-2 border-line-muted pl-3">
        <summary className="min-h-11 cursor-pointer py-3 text-13 font-semibold">Read full {title.toLowerCase()} in both versions</summary>
        <p className="mb-2 text-12 text-muted">The line comparison is abbreviated because it has many separate changes. Both complete versions are below.</p>
        <h5 className="text-13 font-semibold">Version {previousVersion}</h5>
        <pre className="mb-3 min-w-0 break-all whitespace-pre-wrap text-12">{before.join("\n")}</pre>
        <h5 className="text-13 font-semibold">Version {currentVersion}</h5>
        <pre className="min-w-0 break-all whitespace-pre-wrap text-12">{after.join("\n")}</pre>
      </details>}
    </>}
  </section>;
}

/** Read-only comparison; its native disclosure never changes the version or mounts an editor. */
export function ProfileComparison({ previous, current }: { previous: ComparedProfile; current: ComparedProfile }) {
  const sections = [
    { title: "Profile text", before: textLines(previous.markdown), after: textLines(current.markdown) },
    { title: "Pinned statements", before: pinnedLines(previous.pinnedStatements), after: pinnedLines(current.pinnedStatements) },
    { title: "Open questions and answers", before: questionLines(previous.openQuestions), after: questionLines(current.openQuestions) },
  ].map(section => ({ ...section, ...displayDiff(diffLines(section.before, section.after)) }));
  const questionIdentityChanged = JSON.stringify(previous.openQuestions.map(question => question.id)) !== JSON.stringify(current.openQuestions.map(question => question.id));
  const unchanged = sections.every(section => section.added === 0 && section.removed === 0) && !questionIdentityChanged;

  return <details className="mt-4 min-w-0 border-t border-line-muted pt-2">
    <summary className="min-h-11 cursor-pointer py-3 text-14 font-semibold">Compare with previous version</summary>
    <div className="min-w-0 space-y-5 pb-2">
      <p className="text-13 text-muted">Changes from version {previous.version} to version {current.version}. Added lines belong to version {current.version}; removed lines belonged to version {previous.version}.</p>
      {unchanged && <p role="status" className="text-14">No changes to stored profile text, pinned statements or questions.</p>}
      {sections.map(section => <SectionDiff key={section.title} {...section}
        previousVersion={previous.version} currentVersion={current.version}
        identityChanged={section.title === "Open questions and answers" && questionIdentityChanged} />)}
    </div>
  </details>;
}
