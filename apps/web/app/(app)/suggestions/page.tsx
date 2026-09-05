import { acceptSuggestion, findMoreSuggestions, rejectSuggestion } from "@/app/actions/suggestions";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { relativeTime } from "@/lib/format";
import { listPendingSuggestions, listResolvedSuggestions, type SuggestionRow } from "@/lib/queries/suggestions";

export const dynamic = "force-dynamic";

function SuggestionCard({ row }: { row: SuggestionRow }) {
  const { suggestion, profile, similarToNames } = row;
  const verification = suggestion.verification;
  return (
    <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <a href={suggestion.homepageUrl} target="_blank" rel="noopener noreferrer" className="text-base font-semibold text-slate-900 hover:underline dark:text-slate-100">
            {suggestion.name}
          </a>
          {profile?.oneLiner && <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">{profile.oneLiner}</p>}
        </div>
        {suggestion.status !== "pending" && (
          <Badge tone={suggestion.status === "accepted" ? "green" : "gray"}>{suggestion.status}</Badge>
        )}
      </div>

      {similarToNames.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          <span className="text-xs text-slate-400">Similar to:</span>
          {similarToNames.map((n) => (
            <Badge key={n} tone="neutral">
              {n}
            </Badge>
          ))}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        <Badge tone={verification?.homepageOk ? "green" : "red"}>{verification?.homepageOk ? "homepage OK" : "homepage unreachable"}</Badge>
        <Badge tone={verification?.careersSource ? "green" : "amber"}>{verification?.careersSource ? `careers source: ${verification.careersSource.type}` : "no careers source found"}</Badge>
        {typeof verification?.openRoles === "number" && <Badge tone="neutral">{verification.openRoles} open roles</Badge>}
        {typeof verification?.matchingRoles === "number" && <Badge tone="blue">{verification.matchingRoles} matching your keywords</Badge>}
      </div>

      {suggestion.rationale && <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{suggestion.rationale}</p>}

      {suggestion.status === "rejected" && suggestion.rejectionReason && (
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          <span className="font-medium">Rejected: </span>
          {suggestion.rejectionReason}
        </p>
      )}

      {suggestion.status === "pending" && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
          <form action={acceptSuggestion.bind(null, suggestion.id)}>
            <Button type="submit" variant="primary" size="sm">
              Accept
            </Button>
          </form>
          <form action={rejectSuggestion.bind(null, suggestion.id)} className="flex flex-1 items-end gap-2">
            <label className="flex flex-1 flex-col gap-1 text-xs text-slate-500">
              Reason to reject (required)
              <input
                name="reason"
                required
                placeholder="e.g. no agencies, not fintech"
                className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-950"
              />
            </label>
            <Button type="submit" size="sm">
              Reject
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}

export default async function SuggestionsPage() {
  const [pending, resolved] = await Promise.all([listPendingSuggestions(), listResolvedSuggestions()]);
  const now = new Date();

  return (
    <div>
      <PageHeader
        title="Suggestions"
        description="Companies similar to the ones you track, verified before you see them."
        actions={
          <form action={findMoreSuggestions}>
            <Button type="submit" variant="primary">
              Find more
            </Button>
          </form>
        }
      />

      {pending.length === 0 ? (
        <EmptyState title="No pending suggestions" description="Suggestions run weekly, or click Find more to generate them now." />
      ) : (
        <div className="space-y-4">
          {pending.map((row) => (
            <SuggestionCard key={row.suggestion.id} row={row} />
          ))}
        </div>
      )}

      {resolved.length > 0 && (
        <details className="mt-8 rounded-lg border border-slate-200 dark:border-slate-800">
          <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
            Accepted / rejected history ({resolved.length})
          </summary>
          <div className="space-y-3 border-t border-slate-200 p-4 dark:border-slate-800">
            {resolved.map((row) => (
              <div key={row.suggestion.id}>
                <SuggestionCard row={row} />
                {row.suggestion.resolvedAt && (
                  <p className="mt-1 text-xs text-slate-400" title={row.suggestion.resolvedAt.toISOString()}>
                    Resolved {relativeTime(row.suggestion.resolvedAt, now)}
                  </p>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
