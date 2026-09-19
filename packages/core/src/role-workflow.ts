export const ROLE_STATUSES = ["user-shortlisted", "auto-matched", "user-dismissed", "archived"] as const;
export type RoleStatus = typeof ROLE_STATUSES[number];
export const ROLE_STATUS_LABELS: Record<RoleStatus, string> = {
  "user-shortlisted": "Shortlisted", "auto-matched": "Matched",
  "user-dismissed": "Dismissed", archived: "Archived",
};
/**
 * The three the tab strip shows, in order. Archived is a status like any other — it is what a
 * narrowed gate and a closed-out role become — but it is not a tab: archived roles are a section
 * inside Dismissed, so the strip stays the three things a person acts on.
 */
export const ROLE_TABS = ["user-shortlisted", "auto-matched", "user-dismissed"] as const;
/** Archive takes precedence; automation never overrides an active user decision.
 * Legacy retained non-matches appear in Archive until maintenance records their archive event.
 */
export function roleStatus(job: { archivedAt?: Date | string | null; inTable: boolean }, decision?: { decision: "apply" | "skip" } | null): RoleStatus {
  if (job.archivedAt) return "archived";
  if (decision?.decision === "apply") return "user-shortlisted";
  if (decision?.decision === "skip") return "user-dismissed";
  return job.inTable ? "auto-matched" : "archived";
}
