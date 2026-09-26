import { isImportOnlySourceError, sourceIsImportOnly } from "@ava/core";

/**
 * Discovery's forms always have something to say on success, so they name their own result type —
 * but it is the one `ActionResult`, so a discovery action can be used wherever an action is.
 */
export type { ActionResult as DiscoveryActionResult } from "@/lib/validation";
export const SOURCE_KIND_LABELS = { website: "Website", linkedin: "LinkedIn", email: "Email newsletter" } as const;

/** A check more than a day past due means nothing is processing the queue. */
const OVERDUE_MS = 24 * 60 * 60 * 1000;

export type SourceHealthInput = {
  enabled: boolean; suggestionsEnabled: boolean; activeStatus?: string;
  lastError: string | null; waiting: number; lastCheckedAt: Date | null; kind: string;
  nextRunAt?: Date | null; now?: Date;
};

export type SourceHealth = {
  state: string;
  tone: "neutral" | "amber" | "blue";
  /** False only when automation the user expects to run is not running. */
  working: boolean;
  importOnly: boolean;
  detail?: string;
};

export function discoverySourceHealth(input: SourceHealthInput): SourceHealth {
  const importOnly = sourceIsImportOnly(input);
  const ok = (state: string, tone: SourceHealth["tone"] = "neutral", detail?: string): SourceHealth =>
    ({ state, tone, working: true, importOnly, detail });

  if (!input.enabled) return ok("Paused");
  if (!input.suggestionsEnabled) return ok("Discovery disabled");
  if (input.activeStatus === "running") return ok("Checking", "blue");
  if (input.activeStatus === "queued") return ok("Queued", "blue");

  // A failure no retry can clear is a way of working, not a fault.
  if (input.lastError && !isImportOnlySourceError(input.lastError)) {
    return { state: "Not working", tone: "amber", working: false, importOnly,
      detail: "The last check failed. Import the text below, or fix the source URL." };
  }
  if (input.waiting) return ok("Content ready", "blue");
  if (importOnly) {
    return ok(input.kind === "email" ? "Waiting for content" : "Import only", "neutral",
      input.kind === "email" ? undefined : "Paste each edition below to have it read.");
  }
  const overdue = input.nextRunAt && (input.now ?? new Date()).getTime() - input.nextRunAt.getTime() > OVERDUE_MS;
  if (overdue) {
    return { state: "Not working", tone: "amber", working: false, importOnly,
      detail: "This check is more than a day overdue, so the background worker may not be running." };
  }
  return ok(input.lastCheckedAt ? "Up to date" : "Ready for first check");
}

/** Kept for callers that only need the label. */
export function discoverySourceState(input: SourceHealthInput): string {
  return discoverySourceHealth(input).state;
}

/** The sources whose automation the user expects to run and which is not running. */
export function notWorkingSources<T extends SourceHealthInput & { name: string }>(sources: T[]): T[] {
  return sources.filter((source) => !discoverySourceHealth(source).working);
}
