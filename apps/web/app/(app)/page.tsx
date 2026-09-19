import { AutoRefresh } from "@/components/AutoRefresh";
import { getCompanyWorkStatus } from "@/lib/work-status";
import { PageHeader } from "@/components/PageHeader";
import { RoleWorkspace } from "@/components/RoleWorkspace";
import { SuggestionsStrip, type SuggestionChip } from "@/components/SuggestionsStrip";
import { describeFilterSuggestion, extractSuggestionValue } from "@/lib/filterSuggestions";
import { listPendingFilterSuggestionsResolved } from "@/lib/queries/learning";
import { requireUser } from "@/lib/auth";
import type { RawSearchParams } from "@/lib/queries/jobs";
import { Suspense } from "react";
export const dynamic = "force-dynamic";

/** Streams in beside the table rather than holding it back for one more round trip. */
async function WorkNotice({ userId }: { userId: string }) {
  const work = await getCompanyWorkStatus(userId);
  return work.active ? <AutoRefresh message="Scans, discovery or filter updates are pending. Results update as work completes." /> : null;
}

/** At most this many terms on one line; the Learning card carries the rest with their evidence. */
const STRIP_LIMIT = 5;

/** The pending filter suggestions, on the page whose table they would change. Streamed like the notice. */
async function Suggestions({ userId }: { userId: string }) {
  const rows = await listPendingFilterSuggestionsResolved(userId);
  if (rows.length === 0) return null;
  const items: SuggestionChip[] = rows.slice(0, STRIP_LIMIT).map(({ suggestion, companyName }) => {
    const extracted = extractSuggestionValue(suggestion);
    const description = describeFilterSuggestion(suggestion, companyName ?? undefined);
    return {
      id: suggestion.id,
      term: extracted.kind === "term" ? extracted.term : description,
      description,
      fromScans: (suggestion.value as { source?: string }).source === "scans",
    };
  });
  return <SuggestionsStrip items={items} />;
}

export default async function RolesPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const user = await requireUser();
  return <div>
    <Suspense><WorkNotice userId={user.id} /></Suspense>
    <PageHeader title="Roles" />
    <Suspense><Suggestions userId={user.id} /></Suspense>
    <RoleWorkspace userId={user.id} searchParams={await searchParams} />
  </div>;
}
