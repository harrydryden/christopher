export const ROLE_STATUSES = ["auto-matched", "user-shortlisted", "user-dismissed", "archived"] as const;
export type RoleStatus = typeof ROLE_STATUSES[number];
export const ROLE_STATUS_LABELS: Record<RoleStatus, string> = {
  "auto-matched": "Auto-matched", "user-shortlisted": "User-shortlisted",
  "user-dismissed": "User-dismissed", archived: "Archived",
};
/** Archive takes precedence; automation never overrides an active user decision.
 * Legacy retained non-matches appear in Archive until maintenance records their archive event.
 */
export function roleStatus(job: { archivedAt?: Date | string | null; inTable: boolean }, decision?: { decision: "apply" | "skip" } | null): RoleStatus {
  if (job.archivedAt) return "archived";
  if (decision?.decision === "apply") return "user-shortlisted";
  if (decision?.decision === "skip") return "user-dismissed";
  return job.inTable ? "auto-matched" : "archived";
}
