import { expect, it } from "vitest";
import { AUDIT_CLAIM_MS, canStartAuditClaim } from "./live-html-audit-budget";

it("starts a claim only when its full deadline fits the remaining audit wall budget", () => {
  const started = 1_000_000;
  const wallBudget = 15 * 60_000;
  expect(canStartAuditClaim(started, started + wallBudget - AUDIT_CLAIM_MS, wallBudget)).toBe(true);
  expect(canStartAuditClaim(started, started + wallBudget - AUDIT_CLAIM_MS + 1, wallBudget)).toBe(false);
  expect(canStartAuditClaim(started, started, AUDIT_CLAIM_MS - 1)).toBe(false);
});
