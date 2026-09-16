import { isImportOnlySourceError } from "@ava/core";

/**
 * Discovery's forms always have something to say on success, so they name their own result type —
 * but it is the one `ActionResult`, so a discovery action can be used wherever an action is.
 */
export type { ActionResult as DiscoveryActionResult } from "@/lib/validation";
export const SOURCE_KIND_LABELS = { website: "Website", linkedin: "LinkedIn", email: "Email newsletter" } as const;

export function discoverySourceState(input: {
  enabled: boolean; suggestionsEnabled: boolean; activeStatus?: string;
  lastError: string | null; waiting: number; lastCheckedAt: Date | null; kind: string;
}): string {
  if (!input.enabled) return "Paused";
  if (!input.suggestionsEnabled) return "Discovery disabled";
  if (input.activeStatus === "running") return "Checking";
  if (input.activeStatus === "queued") return "Queued";
  const importOnly = isImportOnlySourceError(input.lastError);
  if (input.lastError && !importOnly) return "Needs attention";
  if (input.waiting) return "Content ready";
  if (importOnly) return "Import only";
  if (input.kind === "email") return "Waiting for content";
  return input.lastCheckedAt ? "Up to date" : "Ready for first check";
}
