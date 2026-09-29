/** One local audit claim needs its full deadline inside the caller's wall budget. */
export const AUDIT_CLAIM_MS = 180_000;

export function canStartAuditClaim(startedAtMs: number, nowMs: number, wallBudgetMs: number): boolean {
  return wallBudgetMs - (nowMs - startedAtMs) >= AUDIT_CLAIM_MS;
}
