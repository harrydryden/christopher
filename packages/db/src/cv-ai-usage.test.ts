import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { CvContentSchema, CvLibrarySchema } from "@col/core";
import { createDb } from "./client";
import { runMigrations } from "./migrate";
import { consumeCvCredit, ensureFreeEntitlement, getBillingSummary, grantCvCredits, releaseCvCredit, reserveCvCredit,
  updateBillingAccount,
  revokeCvGrant,
  transferCvCredit } from "./billing";
import { attachCvOpportunityToContext, CV_AI_LIMITS, CvAiUsageError,
  ensureCvOpportunityForContext, ensureCvOpportunityForDraft, getCvAiAllowance,
  reserveCvAiUsage, settleCvAiUsage } from "./cv-ai-usage";
import { creditGrants, creditReservations, cvAiUsage, cvApplicationContexts, cvDrafts,
  cvOpportunities, jobs, users } from "./schema";

const { db, pool } = createDb(process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/col_test", { max: 4 });
beforeAll(() => runMigrations(db));
afterAll(() => pool.end());

const library = CvLibrarySchema.parse({ name: "Ada", contact: "London", profile: "Operations leader", entries: [
  { id: "role", kind: "experience", heading: "Operations", details: "Reduced delays by 20%",
    confirmedResponsibilities: ["Reduced delays by 20%"] },
] });
const content = CvContentSchema.parse({ name: "Ada", contact: "London", summary: "Operations leader", gaps: [], sections: [
  { entryId: "role", kind: "experience", heading: "Operations", bullets: ["Reduced delays by 20%"] },
] });
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

async function account(createdAt = new Date("2026-01-01T00:00:00Z")) {
  const id = randomUUID();
  await db.insert(users).values({ id, email: `usage-${id}@example.com`, claimedAt: createdAt, createdAt });
  return { id, cleanup: () => db.delete(users).where(eq(users.id, id)) };
}
async function context(userId: string, jobId: string | null = null) {
  const [row] = await db.insert(cvApplicationContexts).values({ userId, jobId,
    requestKey: `${jobId ? "new" : "paste"}:${randomUUID()}`, companyName: "Acme", jobTitle: "Operations Lead" }).returning();
  return row!;
}
async function reserve(userId: string, opportunityId: string, key: string, now: Date,
  action: "whole_cv" | "check" | "inline_correction" = "inline_correction") {
  const operationId = randomUUID();
  return db.transaction(tx => reserveCvAiUsage(tx, { userId, opportunityId, operationId,
    requestKey: key, inputHash: hash(key), action, source: { kind: "inline_run", id: operationId }, now }));
}
async function settle(usageId: string, outcome: "ready" | "failed", now: Date) {
  return db.transaction(tx => settleCvAiUsage(tx, { usageId, source: { kind: "inline_run", id: usageId }, outcome, now }));
}

describe("durable opportunity access and AI allowance", () => {
  it("shares one first-credit claim across catalogue contexts, releases failures and charges only a usable result", async () => {
    const user = await account();
    try {
      const [job] = await db.insert(jobs).values({ externalKey: `usage:${randomUUID()}`, title: "Operations Lead",
        normalizedTitle: "operations lead", origin: "manual", manualOwnerId: user.id,
        manualFingerprint: randomUUID(), companyLabel: "Acme", shared: false,
        inputKind: "link", url: `https://example.com/jobs/${randomUUID()}` }).returning({ id: jobs.id });
      const one = await context(user.id, job!.id), two = await context(user.id, job!.id);
      const [a, b] = await Promise.all([
        db.transaction(tx => ensureCvOpportunityForContext(tx, { userId: user.id, contextId: one.id })),
        db.transaction(tx => ensureCvOpportunityForContext(tx, { userId: user.id, contextId: two.id })),
      ]);
      expect(a.opportunityId).toBe(b.opportunityId);
      const now = new Date("2026-01-01T01:00:00Z");
      const first = await reserve(user.id, a.opportunityId, `first:${randomUUID()}`, now, "whole_cv");
      expect(first).toMatchObject({ charge: "role_credit", units: 0, status: "reserved" });
      await expect(reserve(user.id, b.opportunityId, `other:${randomUUID()}`, now, "check"))
        .rejects.toMatchObject({ code: "role_in_flight" });
      expect((await getBillingSummary(db, user.id)).cv).toMatchObject({ available: 2, reserved: 1 });
      expect(await settle(first.usageId, "failed", at(now, 1000))).toBe(true);
      expect((await getBillingSummary(db, user.id)).cv).toMatchObject({ available: 3, reserved: 0 });
      const retry = await reserve(user.id, b.opportunityId, `retry:${randomUUID()}`, at(now, 2000), "check");
      expect(retry.charge).toBe("role_credit");
      expect(await settle(retry.usageId, "ready", at(now, 3000))).toBe(true);
      expect(await settle(retry.usageId, "ready", at(now, 4000))).toBe(false);
      expect((await getBillingSummary(db, user.id)).cv).toMatchObject({ available: 2, reserved: 0 });
      const following = await reserve(user.id, a.opportunityId, `follow:${randomUUID()}`, at(now, 5000), "check");
      expect(following).toMatchObject({ charge: "allowance", units: 2 });
    } finally { await user.cleanup(); }
  });

  it("waits for a pre-cutover held credit on the same posting, then unlocks duplicate contexts", async () => {
    const user = await account();
    try {
      await ensureFreeEntitlement(db, user.id);
      const [job] = await db.insert(jobs).values({ externalKey: `cutover:${randomUUID()}`, title: "Operations Lead",
        normalizedTitle: "operations lead", origin: "manual", manualOwnerId: user.id,
        manualFingerprint: randomUUID(), companyLabel: "Acme", shared: false,
        inputKind: "link", url: `https://example.com/jobs/${randomUUID()}` }).returning({ id: jobs.id });
      const a = await context(user.id, job!.id), b = await context(user.id, job!.id);
      const [legacy] = await db.insert(cvDrafts).values({ userId: user.id, contextId: a.id, jobId: job!.id,
        jobTitle: "Operations Lead", companyName: "Acme", jobDescription: "Lead operations delivery.",
        libraryVersion: 1, librarySnapshot: library, model: "legacy", status: "ready", content }).returning();
      const [grant] = await db.select().from(creditGrants).where(eq(creditGrants.userId, user.id)).limit(1);
      await db.insert(creditReservations).values({ draftId: legacy!.id, userId: user.id,
        grantId: grant!.id, status: "reserved" });
      const claim = await db.transaction(tx => ensureCvOpportunityForContext(tx, { userId: user.id, contextId: b.id }));
      await expect(reserve(user.id, claim.opportunityId, `cutover:${randomUUID()}`, new Date(), "check"))
        .rejects.toMatchObject({ code: "role_in_flight" });
      expect(await db.select().from(cvAiUsage).where(eq(cvAiUsage.userId, user.id))).toHaveLength(0);
      expect(await db.transaction(tx => consumeCvCredit(tx, legacy!.id))).toBe(true);
      const unlocked = await db.transaction(tx => ensureCvOpportunityForContext(tx, { userId: user.id, contextId: b.id }));
      expect(unlocked).toMatchObject({ opportunityId: claim.opportunityId, access: "unlocked" });
      const next = await reserve(user.id, claim.opportunityId, `after-cutover:${randomUUID()}`, new Date(), "check");
      expect(next).toMatchObject({ charge: "allowance", units: 2 });
    } finally { await user.cleanup(); }
  });

  it("does not merge identical pasted adverts without an explicit owned attachment", async () => {
    const user = await account(), other = await account();
    try {
      const a = await context(user.id), b = await context(user.id), c = await context(user.id);
      const first = await db.transaction(tx => ensureCvOpportunityForContext(tx, { userId: user.id, contextId: a.id }));
      const second = await db.transaction(tx => ensureCvOpportunityForContext(tx, { userId: user.id, contextId: b.id }));
      expect(second.opportunityId).not.toBe(first.opportunityId);
      await db.transaction(tx => attachCvOpportunityToContext(tx, { userId: user.id,
        contextId: c.id, opportunityId: first.opportunityId }));
      expect((await db.transaction(tx => ensureCvOpportunityForContext(tx, { userId: user.id,
        contextId: c.id }))).opportunityId).toBe(first.opportunityId);
      await expect(db.transaction(tx => attachCvOpportunityToContext(tx, { userId: other.id,
        contextId: c.id, opportunityId: first.opportunityId }))).rejects.toMatchObject({ code: "source" });
    } finally { await user.cleanup(); await other.cleanup(); }
  });

  it("uses an anchored five-hour session and account-creation seven-day week with held units counted", async () => {
    const created = new Date("2026-01-01T00:00:00Z"), user = await account(created);
    try {
      const c = await context(user.id);
      const { opportunityId } = await db.transaction(tx => ensureCvOpportunityForContext(tx, { userId: user.id, contextId: c.id }));
      const first = await reserve(user.id, opportunityId, "initial", at(created, 1000), "whole_cv");
      await settle(first.usageId, "ready", at(created, 2000));
      const sessionStart = at(created, 60_000);
      const full = await reserve(user.id, opportunityId, "whole-1", sessionStart, "whole_cv");
      expect(full.units).toBe(CV_AI_LIMITS.free.session);
      await expect(reserve(user.id, opportunityId, "over-session", at(sessionStart, 1000)))
        .rejects.toMatchObject({ code: "session_limit", resetAt: at(sessionStart, 5 * 60 * 60 * 1000) });
      await settle(full.usageId, "failed", at(sessionStart, 2000));
      const afterRelease = await reserve(user.id, opportunityId, "after-release", at(sessionStart, 3000), "whole_cv");
      expect(afterRelease.sessionResetAt).toEqual(at(sessionStart, 5 * 60 * 60 * 1000));
      await settle(afterRelease.usageId, "ready", at(sessionStart, 4000));
      const second = await reserve(user.id, opportunityId, "whole-2", at(sessionStart, 5 * 60 * 60 * 1000 + 1), "whole_cv");
      await settle(second.usageId, "ready", at(sessionStart, 5 * 60 * 60 * 1000 + 2));
      const third = await reserve(user.id, opportunityId, "whole-3", at(sessionStart, 10 * 60 * 60 * 1000 + 2), "whole_cv");
      await settle(third.usageId, "ready", at(sessionStart, 10 * 60 * 60 * 1000 + 3));
      await expect(reserve(user.id, opportunityId, "week-full", at(sessionStart, 15 * 60 * 60 * 1000 + 3)))
        .rejects.toMatchObject({ code: "week_limit", resetAt: at(created, 7 * 24 * 60 * 60 * 1000) });
      const reset = await reserve(user.id, opportunityId, "new-week", at(created, 7 * 24 * 60 * 60 * 1000 + 1));
      expect(reset.charge).toBe("allowance");
      const allowance = await getCvAiAllowance(db, user.id, at(created, 7 * 24 * 60 * 60 * 1000 + 1));
      expect(allowance.week).toMatchObject({ limit: 24, used: 0, reserved: 1 });
    } finally { await user.cleanup(); }
  });

  it("grandfathers only a provably paid legacy ancestor when a Manual child is selected", async () => {
    const user = await account();
    try {
      await ensureFreeEntitlement(db, user.id);
      const [grant] = await db.select({ id: creditGrants.id }).from(creditGrants).where(eq(creditGrants.userId, user.id)).limit(1);
      const parentId = randomUUID(), childId = randomUUID();
      await db.insert(cvDrafts).values([
        { id: parentId, userId: user.id, jobTitle: "Lead", companyName: "Acme", jobDescription: "A long original vacancy description for this role.",
          libraryVersion: 1, librarySnapshot: library, model: "legacy-model", status: "ready", content },
        { id: childId, userId: user.id, parentId, editingMode: "manual", jobTitle: "Lead", companyName: "Acme",
          jobDescription: "A long original vacancy description for this role.", libraryVersion: 1,
          librarySnapshot: library, model: "manual", status: "ready", content },
      ]);
      await db.insert(creditReservations).values({ draftId: parentId, userId: user.id, grantId: grant!.id,
        status: "consumed", settledAt: new Date() });
      const source = await db.transaction(tx => ensureCvOpportunityForDraft(tx, { userId: user.id, draftId: childId }));
      expect(source.access).toBe("unlocked");
      const check = await reserve(user.id, source.opportunityId, "legacy-check", new Date("2026-01-02T00:00:00Z"), "check");
      expect(check).toMatchObject({ charge: "allowance", units: 2 });
      expect((await db.select().from(cvOpportunities).where(eq(cvOpportunities.id, source.opportunityId)))[0]?.grandfatherProof)
        .toBe(`ready_draft:${parentId}`);
    } finally { await user.cleanup(); }
  });

  it("fences quote, request identity and stale terminal retries without another reservation", async () => {
    const user = await account();
    try {
      const c = await context(user.id), now = new Date("2026-01-01T01:00:00Z");
      const { opportunityId } = await db.transaction(tx => ensureCvOpportunityForContext(tx, { userId: user.id, contextId: c.id }));
      const operationId = randomUUID(), key = `quoted:${randomUUID()}`;
      const input = { userId: user.id, opportunityId, operationId, requestKey: key, inputHash: hash(key),
        action: "inline_refine" as const, source: { kind: "inline_run" as const, id: operationId }, now };
      await expect(db.transaction(tx => reserveCvAiUsage(tx, { ...input, expectedCharge: "allowance" })))
        .rejects.toMatchObject({ code: "request_conflict" });
      const first = await db.transaction(tx => reserveCvAiUsage(tx, { ...input, expectedCharge: "role_credit", expectedUnits: 0 }));
      expect((await db.transaction(tx => reserveCvAiUsage(tx, input))).status).toBe("in_flight");
      await expect(db.transaction(tx => reserveCvAiUsage(tx, { ...input, inputHash: hash("changed") })))
        .rejects.toMatchObject({ code: "request_conflict" });
      await settle(first.usageId, "failed", at(now, 1000));
      expect((await db.transaction(tx => reserveCvAiUsage(tx, input))).status).toBe("released");
      expect((await db.select().from(cvAiUsage).where(eq(cvAiUsage.userId, user.id)))).toHaveLength(1);
    } finally { await user.cleanup(); }
  });

  it("routes a real draft through the shared ledger, transfers its continuation and permits a later Check", async () => {
    const user = await account();
    try {
      const c = await context(user.id), parentId = randomUUID(), continuationId = randomUUID();
      for (const id of [parentId, continuationId]) await db.insert(cvDrafts).values({ id, userId: user.id,
        contextId: c.id, jobTitle: "Operations Lead", companyName: "Acme", jobDescription: "Lead operations delivery.",
        libraryVersion: 1, librarySnapshot: library, model: "test", status: "queued" });
      await db.transaction(tx => reserveCvCredit(tx, user.id, parentId));
      expect(await db.select().from(creditReservations).where(eq(creditReservations.draftId, parentId))).toHaveLength(0);
      expect(await db.transaction(tx => transferCvCredit(tx, parentId, continuationId))).toBe(true);
      expect(await db.transaction(tx => consumeCvCredit(tx, continuationId))).toBe(true);
      const [role] = await db.select().from(cvOpportunities).where(eq(cvOpportunities.userId, user.id));
      expect(role?.firstSuccessAt).not.toBeNull();
      await expect(db.transaction(tx => reserveCvCredit(tx, user.id, continuationId, new Date(), "check",
        { charge: "role_credit", units: 0, priceVersion: 1 }))).rejects.toMatchObject({ code: "request_conflict" });
      await db.transaction(tx => reserveCvCredit(tx, user.id, continuationId, new Date(), "check",
        { charge: "allowance", units: 2, priceVersion: 1 }));
      const usages = await db.select().from(cvAiUsage).where(eq(cvAiUsage.userId, user.id));
      expect(usages.map(row => [row.chargeKind, row.units, row.status]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
        ["allowance", 2, "reserved"],
        ["role_credit", 0, "consumed"],
      ]);
      expect(await db.transaction(tx => releaseCvCredit(tx, continuationId))).toBe(true);
      await db.transaction(tx => reserveCvCredit(tx, user.id, continuationId, new Date(), "check"));
      expect((await db.select().from(cvAiUsage).where(eq(cvAiUsage.userId, user.id)))).toHaveLength(3);
    } finally { await user.cleanup(); }
  });

  it("rejects a foreign draft rather than using the orphan legacy credit path", async () => {
    const owner = await account(), other = await account();
    try {
      const id = randomUUID();
      await db.insert(cvDrafts).values({ id, userId: owner.id, jobTitle: "Lead", companyName: "Acme",
        jobDescription: "Lead operations delivery.", libraryVersion: 1, librarySnapshot: library,
        model: "test", status: "queued" });
      await expect(db.transaction(tx => reserveCvCredit(tx, other.id, id)))
        .rejects.toMatchObject({ code: "source" });
      expect(await db.select().from(cvAiUsage).where(eq(cvAiUsage.userId, other.id))).toHaveLength(0);
    } finally { await owner.cleanup(); await other.cleanup(); }
  });

  it("does not restore or settle a refunded role-credit hold", async () => {
    const user = await account();
    try {
      await ensureFreeEntitlement(db, user.id);
      for (let n = 0; n < 3; n++) await reserveCvCredit(db, user.id, randomUUID());
      const ref = `topup:${randomUUID()}`;
      await grantCvCredits(db, { userId: user.id, source: "topup", units: 1, externalRef: ref });
      const c = await context(user.id);
      const { opportunityId } = await db.transaction(tx => ensureCvOpportunityForContext(tx, { userId: user.id, contextId: c.id }));
      const now = new Date("2026-01-01T01:00:00Z");
      const held = await reserve(user.id, opportunityId, `refundable:${randomUUID()}`, now);
      expect(held.charge).toBe("role_credit");
      expect(await revokeCvGrant(db, ref, "Refunded by provider")).toBe(0);
      await expect(settle(held.usageId, "ready", at(now, 1000)))
        .rejects.toMatchObject({ code: "credits" });
      expect(await settle(held.usageId, "failed", at(now, 2000))).toBe(true);
      const [grant] = await db.select().from(creditGrants).where(eq(creditGrants.externalRef, ref));
      expect(grant?.remaining).toBe(0);
      expect((await db.select().from(cvOpportunities).where(eq(cvOpportunities.id, opportunityId)))[0]?.firstSuccessAt).toBeNull();
    } finally { await user.cleanup(); }
  });

  it("serialises concurrent quota admission and preserves held work across a downgrade", async () => {
    const created = new Date("2026-01-01T00:00:00Z"), user = await account(created);
    try {
      const c = await context(user.id);
      const { opportunityId } = await db.transaction(tx => ensureCvOpportunityForContext(tx, { userId: user.id, contextId: c.id }));
      const first = await reserve(user.id, opportunityId, "initial-concurrent", at(created, 1000));
      await settle(first.usageId, "ready", at(created, 2000));
      const now = at(created, 5000);
      for (const key of ["fill-1", "fill-2", "fill-3", "fill-4", "fill-5", "fill-6", "fill-7"])
        await reserve(user.id, opportunityId, key, now);
      const contenders = await Promise.allSettled([
        reserve(user.id, opportunityId, "contender-a", now),
        reserve(user.id, opportunityId, "contender-b", now),
      ]);
      expect(contenders.filter(row => row.status === "fulfilled")).toHaveLength(1);
      expect(contenders.filter(row => row.status === "rejected")).toHaveLength(1);
      expect((contenders.find(row => row.status === "rejected") as PromiseRejectedResult).reason)
        .toMatchObject({ code: "session_limit" });
      expect((await getCvAiAllowance(db, user.id, now)).session).toMatchObject({ used: 0, reserved: 8 });
      await updateBillingAccount(db, user.id, { plan: "search" });
      const upgraded = await reserve(user.id, opportunityId, "after-upgrade", now, "whole_cv");
      expect(upgraded).toMatchObject({ charge: "allowance", units: 8 });
      await updateBillingAccount(db, user.id, { plan: "free" });
      await expect(reserve(user.id, opportunityId, "after-downgrade", now))
        .rejects.toMatchObject({ code: "session_limit" });
      expect((await db.select().from(cvAiUsage).where(eq(cvAiUsage.id, upgraded.usageId)))[0]?.status).toBe("reserved");
    } finally { await user.cleanup(); }
  });
});
