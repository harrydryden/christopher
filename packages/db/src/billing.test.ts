/**
 * Credit and company entitlements against the real schema.
 * Requires TEST_DATABASE_URL (defaults to the local col_test database).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb } from "./client";
import { runMigrations } from "./migrate";
import {
  BillingLimitError,
  assertCanActivateCompanies,
  consumeCvCredit,
  ensureFreeEntitlement,
  getBillingSummary,
  grantCvCredits,
  releaseCvCredit,
  reserveCvCredit,
  revokeCvGrant,
  transferCvCredit,
  updateBillingAccount,
} from "./billing";
import { companies, companySubscriptions, users } from "./schema";

const { db, pool } = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/col_test", { max: 1 });
beforeAll(() => runMigrations(db));
afterAll(() => pool.end());

async function account() {
  const id = randomUUID();
  await db.insert(users).values({ id, email: `billing-${id}@example.com`, claimedAt: new Date() });
  return {
    id,
    cleanup: () => db.delete(users).where(eq(users.id, id)),
  };
}

describe("CV credits", () => {
  it("grants the first three builds once and reserves atomically", async () => {
    const user = await account();
    try {
      await ensureFreeEntitlement(db, user.id);
      await ensureFreeEntitlement(db, user.id);
      expect((await getBillingSummary(db, user.id)).cv).toMatchObject({ available: 3, welcome: 3, reserved: 0 });
      const drafts = [randomUUID(), randomUUID(), randomUUID()];
      for (const draft of drafts) await db.transaction(tx => reserveCvCredit(tx, user.id, draft));
      expect((await getBillingSummary(db, user.id)).cv).toMatchObject({ available: 0, reserved: 3 });
      await expect(db.transaction(tx => reserveCvCredit(tx, user.id, randomUUID())))
        .rejects.toMatchObject({ code: "cv_credits_exhausted" });
      await db.transaction(tx => releaseCvCredit(tx, drafts[0]!, "test failure"));
      await db.transaction(tx => consumeCvCredit(tx, drafts[1]!));
      expect((await getBillingSummary(db, user.id)).cv).toMatchObject({ available: 1, reserved: 1 });
    } finally {
      await user.cleanup();
    }
  });

  it("keeps purchased credits and transfers a quiz hold without charging twice", async () => {
    const user = await account();
    try {
      const checkout = `checkout:${user.id}`;
      await grantCvCredits(db, { userId: user.id, source: "topup", units: 5, externalRef: checkout });
      expect((await getBillingSummary(db, user.id)).cv).toMatchObject({ available: 8, welcome: 3, purchased: 5 });
      const parent = randomUUID(), continuation = randomUUID();
      await db.transaction(async tx => {
        await reserveCvCredit(tx, user.id, parent);
        expect(await transferCvCredit(tx, parent, continuation)).toBe(true);
        expect(await consumeCvCredit(tx, continuation)).toBe(true);
      });
      expect((await getBillingSummary(db, user.id)).cv).toMatchObject({ available: 7, reserved: 0 });
      expect(await revokeCvGrant(db, checkout, "refunded")).toBe(5);
      expect(await revokeCvGrant(db, checkout, "duplicate refund")).toBe(0);
      expect((await getBillingSummary(db, user.id)).cv).toMatchObject({ available: 2, purchased: 0 });
    } finally {
      await user.cleanup();
    }
  });
});

describe("company capacity", () => {
  it("counts active companies only and observes paid plan block ceilings", async () => {
    const user = await account();
    try {
      const companyRows = await db.insert(companies).values(Array.from({ length: 27 }, (_, n) => ({
        name: `Billing company ${user.id}-${n}`,
        homepageUrl: `https://billing-${user.id}-${n}.example.com`,
        domain: `billing-${user.id}-${n}.example.com`,
      }))).returning({ id: companies.id });
      await db.insert(companySubscriptions).values(companyRows.slice(0, 25).map(row => ({ userId: user.id, companyId: row.id, status: "active" as const })));
      await db.insert(companySubscriptions).values({ userId: user.id, companyId: companyRows[25]!.id, status: "paused" });
      expect((await getBillingSummary(db, user.id)).companies).toMatchObject({ active: 25, capacity: 25, remaining: 0 });
      await expect(assertCanActivateCompanies(db, user.id, 1)).rejects.toBeInstanceOf(BillingLimitError);
      await updateBillingAccount(db, user.id, { plan: "search", companyBlocks: 1 });
      expect((await getBillingSummary(db, user.id)).companies).toMatchObject({ active: 25, included: 100, capacity: 110 });
      await expect(assertCanActivateCompanies(db, user.id, 85)).resolves.toMatchObject({ capacity: 110 });
      await expect(assertCanActivateCompanies(db, user.id, 86)).rejects.toMatchObject({ code: "company_capacity" });
      await db.update(companySubscriptions).set({ status: "active" }).where(eq(companySubscriptions.companyId, companyRows[25]!.id));
      await db.insert(companySubscriptions).values({ userId: user.id, companyId: companyRows[26]!.id, status: "active" });
      await updateBillingAccount(db, user.id, { status: "past_due", graceEndsAt: new Date("2026-01-01T00:00:00Z") });
      expect((await getBillingSummary(db, user.id, new Date("2026-01-08T00:00:00Z"))).companies)
        .toMatchObject({ active: 25, capacity: 25 });
    } finally {
      await user.cleanup();
    }
  });
});
