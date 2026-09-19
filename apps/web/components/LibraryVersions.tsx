import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { SearchForm, SearchPending } from "@/components/SearchForm";
import { selectClass } from "@/components/Field";
import { relativeTime, shortDate } from "@/lib/format";
import { libraryDiffSummary, type LibraryDiff } from "@/lib/cv-library-diff";

export interface LibraryVersionRow {
  version: number;
  createdAt: Date;
}

/** One block's rows, added, removed and reworded, as a plain list. */
function BlockChanges({ block }: { block: LibraryDiff["blocks"][number] }) {
  return (
    <li className="space-y-1">
      <p className="text-14 font-semibold">{block.label}</p>
      <ul className="space-y-1 text-13 text-muted">
        {block.added.map(row => <li key={`add-${row}`}>Added · {row}</li>)}
        {block.removed.map(row => <li key={`remove-${row}`}>Removed · {row}</li>)}
        {block.changed.map(change => (
          <li key={`change-${change.before}`}>Reworded · {change.before} → {change.after}</li>
        ))}
      </ul>
    </li>
  );
}

/**
 * Every saved version of the Library, and what changed between any two of them.
 *
 * A save appends an immutable version and the interface never rewrites one, so this is read only:
 * the history is here to be understood, and the way to go back to older wording is to type it and
 * save again, which appends a version like any other edit.
 */
export function LibraryVersions({
  versions,
  current,
  diff,
  now = new Date(),
}: {
  versions: LibraryVersionRow[];
  current: number;
  diff: LibraryDiff | null;
  now?: Date;
}) {
  const pick = (name: "a" | "b", value: number) => (
    <select
      name={name}
      defaultValue={value}
      aria-label={name === "a" ? "Compare version" : "With version"}
      className={`w-auto py-1 text-12 ${selectClass}`}
    >
      {versions.map(row => <option key={row.version} value={row.version}>v{row.version}</option>)}
    </select>
  );
  return (
    <Card
      title="Versions"
      actions={versions.length > 1 && (
        <SearchForm action="/library" className="flex flex-wrap items-center gap-2">
          {pick("a", diff?.from ?? versions[1]!.version)}
          <span className="text-12 text-muted">with</span>
          {pick("b", diff?.to ?? versions[0]!.version)}
          <Button type="submit" size="sm">Compare</Button>
          <SearchPending />
        </SearchForm>
      )}
    >
      {versions.length === 0 ? (
        <p className="text-14 text-muted">Nothing saved yet. Your first save becomes version 1.</p>
      ) : (
        <ul className="space-y-1 text-14">
          {versions.map(row => (
            <li key={row.version} className="flex flex-wrap items-baseline gap-x-3">
              <span>Version {row.version}</span>
              <span className="text-12 text-muted">
                {shortDate(row.createdAt)} · {relativeTime(row.createdAt, now)}
              </span>
              {row.version === current && <span className="text-12 text-muted">Current</span>}
            </li>
          ))}
        </ul>
      )}
      {diff && (
        <div className="mt-4 space-y-2 border-t-2 border-line-muted pt-4">
          <p className="text-14">
            Version {diff.from} to version {diff.to} · {libraryDiffSummary(diff)}
          </p>
          {diff.employmentAdded.length > 0 && <p className="text-13 text-muted">Jobs added · {diff.employmentAdded.join(", ")}</p>}
          {diff.employmentRemoved.length > 0 && <p className="text-13 text-muted">Jobs removed · {diff.employmentRemoved.join(", ")}</p>}
          {diff.blocksAdded.length > 0 && <p className="text-13 text-muted">Blocks added · {diff.blocksAdded.join(", ")}</p>}
          {diff.blocksRemoved.length > 0 && <p className="text-13 text-muted">Blocks removed · {diff.blocksRemoved.join(", ")}</p>}
          {diff.blocks.length > 0 && (
            <ul className="space-y-3">{diff.blocks.map(block => <BlockChanges key={block.entryId} block={block} />)}</ul>
          )}
        </div>
      )}
    </Card>
  );
}
