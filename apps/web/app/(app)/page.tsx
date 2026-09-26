import { AutoRefresh } from "@/components/AutoRefresh";
import { getRolesWorkStatus } from "@/lib/work-status";
import { PageHeader } from "@/components/PageHeader";
import { RoleWorkspace } from "@/components/RoleWorkspace";
import { SetupChecklist } from "@/components/SetupChecklist";
import { SuggestionsStrip, type SuggestionChip } from "@/components/SuggestionsStrip";
import { describeFilterSuggestion, extractSuggestionValue } from "@/lib/filterSuggestions";
import { listPendingFilterSuggestionsResolved } from "@/lib/queries/learning";
import { setupStatus } from "@/lib/queries/setup";
import { buildSetupChecklist } from "@/lib/setup";
import { requireUser } from "@/lib/auth";
import { fetchRoleCounts, type RawSearchParams } from "@/lib/queries/jobs";
import { Suspense } from "react";
export const dynamic = "force-dynamic";

/**
 * Streams in beside the table rather than holding it back for one more round trip. Silent: it only
 * refreshes the page as work completes, and the status strip at the top says what is happening.
 * Nothing on this page shows a task's own state, so it watches the `roles` version, which moves
 * when a task arrives or finishes and not when one merely starts running.
 */
async function WorkNotice({ userId }: { userId: string }) {
  const work = await getRolesWorkStatus(userId);
  return work.active ? <AutoRefresh scope="roles" initialVersion={work.version} message={null} /> : null;
}

/** At most this many terms on one line; the Learning card carries the rest with their evidence. */
const STRIP_LIMIT = 5;

/**
 * What to do next, derived from rows and streamed like the notice above it. An account with nothing
 * in its table gets the checklist as the page's explanation, because there the blank table is the
 * question; an account with roles gets a card it can hide. Finished setup shows nothing.
 */
async function Setup({ userId }: { userId: string }) {
  const checklist = buildSetupChecklist(await setupStatus(userId));
  if (checklist.complete) return null;
  const counts = await fetchRoleCounts(userId);
  if (Object.values(counts).every((n) => n === 0)) return <SetupChecklist checklist={checklist} variant="explanation" />;
  return checklist.dismissed ? null : <SetupChecklist checklist={checklist} variant="card" />;
}

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
    <Suspense><Setup userId={user.id} /></Suspense>
    <Suspense><Suggestions userId={user.id} /></Suspense>
    <RoleWorkspace userId={user.id} searchParams={await searchParams} />
  </div>;
}
