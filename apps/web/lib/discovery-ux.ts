/** Serializable feedback shared by discovery actions and forms. */
export type DiscoveryActionResult = { ok: true; message: string } | { ok: false; error: string };
export const SOURCE_KIND_LABELS = { website: "Website", linkedin: "LinkedIn", email: "Email newsletter" } as const;

export function discoverySourceState(input: {
  enabled: boolean; suggestionsEnabled: boolean; activeStatus?: string;
  lastError: string | null; waiting: number; lastCheckedAt: Date | null; kind: string;
}): string {
  if (!input.enabled) return "Paused";
  if (!input.suggestionsEnabled) return "Discovery disabled";
  if (input.activeStatus === "running") return "Checking";
  if (input.activeStatus === "queued") return "Queued";
  if (input.lastError) return "Needs attention";
  if (input.waiting) return "Content ready";
  if (input.kind === "email") return "Waiting for content";
  return input.lastCheckedAt ? "Up to date" : "Ready for first check";
}
