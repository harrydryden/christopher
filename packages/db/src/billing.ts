import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "./client";
import {
  billingAccounts,
  billingEvents,
  companySubscriptions,
  creditGrants,
  creditLedger,
  creditReservations,
  type BillingPlan,
  type BillingStatus,
  type CreditGrantSource,
} from "./schema";
import { setSubscriptionStatus } from "./subscriptions";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type BillingWriter = Db | Transaction;

export const PLAN_CATALOG = {
  free: { label: "Free", monthlyGbp: 0, includedCompanies: 25, monthlyCvCredits: 0, maxCompanies: 25 },
  search: { label: "Search", monthlyGbp: 29, includedCompanies: 100, monthlyCvCredits: 10, maxCompanies: 150 },
  intensive: { label: "Intensive", monthlyGbp: 49, includedCompanies: 200, monthlyCvCredits: 20, maxCompanies: 200 },
} as const satisfies Record<BillingPlan, {
  label: string;
  monthlyGbp: number;
  includedCompanies: number;
  monthlyCvCredits: number;
  maxCompanies: number;
}>;

export const CV_TOPUPS = {
  cv5: { credits: 5, priceGbp: 5 },
  cv10: { credits: 10, priceGbp: 9 },
  cv20: { credits: 20, priceGbp: 15 },
} as const;
export type CvTopupKey = keyof typeof CV_TOPUPS;

export const COMPANY_BLOCK_SIZE = 10;
export const COMPANY_BLOCK_PRICE_GBP = 1;
export const TECHNICAL_COMPANY_LIMIT = 200;
export const WELCOME_CV_CREDITS = 3;

export interface BillingSummary {
  plan: BillingPlan;
  planLabel: string;
  status: BillingStatus;
  monthlyPriceGbp: number;
  renewalAt: Date | null;
  cancelAtPeriodEnd: boolean;
  paymentNeedsAttention: boolean;
  graceEndsAt: Date | null;
  stripeCustomerId: string | null;
  cv: {
    available: number;
    reserved: number;
    monthly: number;
    welcome: number;
    purchased: number;
    nextGrantAt: Date | null;
  };
  companies: {
    active: number;
    included: number;
    paidBlocks: number;
    capacity: number;
    technicalMax: number;
    remaining: number;
  };
}

export class BillingLimitError extends Error {
  readonly userFacing = true as const;
  readonly code: "cv_credits_exhausted" | "company_capacity" | "company_technical_limit";
  readonly recovery = { href: "/account#plan-and-credits", label: "Manage plan and credits" };

  constructor(code: BillingLimitError["code"], message: string) {
    super(message);
    this.name = "BillingLimitError";
    this.code = code;
  }
}

/** A root Drizzle database owns transactions; an existing transaction exposes no pool client. */
function isRootDatabase(writer: BillingWriter): writer is Db {
  return "$client" in writer;
}

async function lockBilling(writer: BillingWriter, userId: string): Promise<void> {
  await writer.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:${userId}`}, 0))`);
}

/** Idempotently gives every account its Free entitlement and three lifetime welcome credits. */
export async function ensureFreeEntitlement(writer: BillingWriter, userId: string): Promise<void> {
  if (isRootDatabase(writer)) return writer.transaction(tx => ensureFreeEntitlement(tx, userId));
  await lockBilling(writer, userId);
  await writer.insert(billingAccounts).values({ userId }).onConflictDoNothing();
  const externalRef = `welcome:${userId}`;
  const [grant] = await writer.insert(creditGrants).values({
    userId,
    source: "welcome",
    units: WELCOME_CV_CREDITS,
    remaining: WELCOME_CV_CREDITS,
    externalRef,
  }).onConflictDoNothing().returning({ id: creditGrants.id });
  if (grant) await writer.insert(creditLedger).values({
    userId,
    grantId: grant.id,
    kind: "grant",
    delta: WELCOME_CV_CREDITS,
    idempotencyKey: `grant:${externalRef}`,
    note: "First three CV builds",
  }).onConflictDoNothing();
}

function effectivePlan(account: typeof billingAccounts.$inferSelect, now: Date): BillingPlan {
  if (account.status === "cancelled") return "free";
  if (account.status === "past_due" && account.graceEndsAt && account.graceEndsAt <= now) return "free";
  return account.plan;
}

export async function getBillingSummary(database: BillingWriter, userId: string, now = new Date()): Promise<BillingSummary> {
  const [account] = await database.select().from(billingAccounts).where(eq(billingAccounts.userId, userId)).limit(1);
  const rows = await database.execute<{
    monthly: number;
    welcome: number;
    purchased: number;
    reserved: number;
    active_companies: number;
  }>(sql`
    select
      coalesce(sum(g.remaining) filter (where g.source = 'monthly' and (g.expires_at is null or g.expires_at > ${now})), 0)::int as monthly,
      coalesce(sum(g.remaining) filter (where g.source = 'welcome' and (g.expires_at is null or g.expires_at > ${now})), 0)::int as welcome,
      coalesce(sum(g.remaining) filter (where g.source in ('topup', 'admin') and (g.expires_at is null or g.expires_at > ${now})), 0)::int as purchased,
      (select count(*)::int from credit_reservations r where r.user_id = ${userId}::uuid and r.status = 'reserved') as reserved,
      (select count(*)::int from company_subscriptions s where s.user_id = ${userId}::uuid and s.status = 'active') as active_companies
    from credit_grants g where g.user_id = ${userId}::uuid`);
  const balances = rows.rows[0] ?? { monthly: 0, welcome: 0, purchased: 0, reserved: 0, active_companies: 0 };
  const stored = account ?? {
    userId,
    plan: "free" as const,
    status: "active" as const,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    companyBlocks: 0,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    graceEndsAt: null,
    stripeEventCreatedAt: 0,
    createdAt: now,
    updatedAt: now,
  };
  const plan = effectivePlan(stored, now);
  const definition = PLAN_CATALOG[plan];
  const maximumBlocks = Math.max(0, Math.floor((definition.maxCompanies - definition.includedCompanies) / COMPANY_BLOCK_SIZE));
  const paidBlocks = plan === "free" ? 0 : Math.min(maximumBlocks, Math.max(0, stored.companyBlocks));
  const capacity = Math.min(definition.maxCompanies, definition.includedCompanies + paidBlocks * COMPANY_BLOCK_SIZE);
  const available = Number(balances.monthly) + Number(balances.welcome) + Number(balances.purchased);
  let active = Number(balances.active_companies);
  if (stored.status === "past_due" && stored.graceEndsAt && stored.graceEndsAt <= now && active > capacity) {
    await reconcileCompanyCapacity(database, userId, capacity);
    active = capacity;
  }
  return {
    plan,
    planLabel: definition.label,
    status: stored.status,
    monthlyPriceGbp: definition.monthlyGbp + paidBlocks * COMPANY_BLOCK_PRICE_GBP,
    renewalAt: stored.currentPeriodEnd,
    cancelAtPeriodEnd: stored.cancelAtPeriodEnd,
    paymentNeedsAttention: stored.status === "past_due",
    graceEndsAt: stored.graceEndsAt,
    stripeCustomerId: stored.stripeCustomerId,
    cv: {
      available,
      reserved: Number(balances.reserved),
      monthly: Number(balances.monthly),
      welcome: Number(balances.welcome),
      purchased: Number(balances.purchased),
      nextGrantAt: plan === "free" ? null : stored.currentPeriodEnd,
    },
    companies: {
      active,
      included: definition.includedCompanies,
      paidBlocks,
      capacity,
      technicalMax: TECHNICAL_COMPANY_LIMIT,
      remaining: Math.max(0, capacity - active),
    },
  };
}

export async function getCompanyEntitlement(database: BillingWriter, userId: string, now = new Date()) {
  const summary = await getBillingSummary(database, userId, now);
  return { plan: summary.plan, status: summary.status, ...summary.companies };
}

export async function assertCanActivateCompanies(database: BillingWriter, userId: string, increment = 1, now = new Date()) {
  if (!Number.isInteger(increment) || increment < 0) throw new Error("Company increment must be a non-negative integer.");
  const entitlement = await getCompanyEntitlement(database, userId, now);
  const target = entitlement.active + increment;
  if (target > TECHNICAL_COMPANY_LIMIT) throw new BillingLimitError(
    "company_technical_limit",
    `AVA can monitor at most ${TECHNICAL_COMPANY_LIMIT} active companies for one account.`,
  );
  if (target > entitlement.capacity) {
    const message = entitlement.plan === "free"
      ? `Free includes ${entitlement.included} active companies. Pause one or compare plans to follow another.`
      : entitlement.capacity >= PLAN_CATALOG[entitlement.plan].maxCompanies
        ? `${PLAN_CATALOG[entitlement.plan].label} currently supports ${entitlement.capacity} active companies. Pause one${entitlement.plan === "search" ? " or compare plans" : ""} to follow another.`
        : `Your plan currently has space for ${entitlement.capacity} active companies. Add another 10 places in Account before following more.`;
    throw new BillingLimitError("company_capacity", message);
  }
  return entitlement;
}

/** Reserve exactly one credit before a new AI-written CV is queued. Idempotent by draft. */
export async function reserveCvCredit(writer: BillingWriter, userId: string, draftId: string, now = new Date()): Promise<void> {
  if (isRootDatabase(writer)) return writer.transaction(tx => reserveCvCredit(tx, userId, draftId, now));
  await ensureFreeEntitlement(writer, userId);
  const [existing] = await writer.select().from(creditReservations).where(eq(creditReservations.draftId, draftId)).limit(1).for("update");
  if (existing?.status === "reserved" || existing?.status === "consumed") return;
  const [grant] = await writer.select({ id: creditGrants.id }).from(creditGrants).where(and(
    eq(creditGrants.userId, userId),
    gt(creditGrants.remaining, 0),
    or(isNull(creditGrants.expiresAt), gt(creditGrants.expiresAt, now)),
  )).orderBy(
    sql`${creditGrants.expiresAt} asc nulls last`,
    sql`case ${creditGrants.source} when 'monthly' then 0 when 'welcome' then 1 when 'topup' then 2 else 3 end`,
    creditGrants.createdAt,
  ).limit(1).for("update");
  if (!grant) throw new BillingLimitError("cv_credits_exhausted", "You have no CV credits available. Add credits in Account to build this CV.");
  await writer.update(creditGrants).set({ remaining: sql`${creditGrants.remaining} - 1` }).where(eq(creditGrants.id, grant.id));
  if (existing) await writer.update(creditReservations).set({
    userId,
    grantId: grant.id,
    status: "reserved",
    reservedAt: now,
    settledAt: null,
  }).where(eq(creditReservations.draftId, draftId));
  else await writer.insert(creditReservations).values({ draftId, userId, grantId: grant.id, reservedAt: now });
  await writer.insert(creditLedger).values({
    userId,
    grantId: grant.id,
    draftId,
    kind: "reserve",
    delta: -1,
    idempotencyKey: `reserve:${draftId}:${now.toISOString()}`,
  });
}

export async function consumeCvCredit(writer: BillingWriter, draftId: string, now = new Date()): Promise<boolean> {
  if (isRootDatabase(writer)) return writer.transaction(tx => consumeCvCredit(tx, draftId, now));
  const [reservation] = await writer.select().from(creditReservations).where(eq(creditReservations.draftId, draftId)).limit(1).for("update");
  if (!reservation || reservation.status !== "reserved") return false;
  await writer.update(creditReservations).set({ status: "consumed", settledAt: now }).where(eq(creditReservations.draftId, draftId));
  await writer.insert(creditLedger).values({
    userId: reservation.userId,
    grantId: reservation.grantId,
    draftId,
    kind: "consume",
    delta: 0,
    idempotencyKey: `consume:${draftId}`,
  }).onConflictDoNothing();
  return true;
}

export async function releaseCvCredit(writer: BillingWriter, draftId: string, reason = "Build did not complete", now = new Date()): Promise<boolean> {
  if (isRootDatabase(writer)) return writer.transaction(tx => releaseCvCredit(tx, draftId, reason, now));
  const [reservation] = await writer.select().from(creditReservations).where(eq(creditReservations.draftId, draftId)).limit(1).for("update");
  if (!reservation || reservation.status !== "reserved") return false;
  await writer.update(creditGrants).set({ remaining: sql`${creditGrants.remaining} + 1` }).where(eq(creditGrants.id, reservation.grantId));
  await writer.update(creditReservations).set({ status: "released", settledAt: now }).where(eq(creditReservations.draftId, draftId));
  await writer.insert(creditLedger).values({
    userId: reservation.userId,
    grantId: reservation.grantId,
    draftId,
    kind: "release",
    delta: 1,
    idempotencyKey: `release:${draftId}`,
    note: reason.slice(0, 500),
  }).onConflictDoNothing();
  return true;
}

/** Move a held credit to an evidence-quiz continuation without charging twice. */
export async function transferCvCredit(writer: BillingWriter, fromDraftId: string, toDraftId: string): Promise<boolean> {
  if (isRootDatabase(writer)) return writer.transaction(tx => transferCvCredit(tx, fromDraftId, toDraftId));
  const [reservation] = await writer.select().from(creditReservations).where(eq(creditReservations.draftId, fromDraftId)).limit(1).for("update");
  if (!reservation || reservation.status !== "reserved") return false;
  const [target] = await writer.select().from(creditReservations).where(eq(creditReservations.draftId, toDraftId)).limit(1).for("update");
  if (target) return target.status === "reserved" || target.status === "consumed";
  await writer.update(creditReservations).set({ draftId: toDraftId }).where(eq(creditReservations.draftId, fromDraftId));
  await writer.insert(creditLedger).values({
    userId: reservation.userId,
    grantId: reservation.grantId,
    draftId: toDraftId,
    kind: "transfer",
    delta: 0,
    idempotencyKey: `transfer:${fromDraftId}:${toDraftId}`,
    note: `Continued from ${fromDraftId}`,
  }).onConflictDoNothing();
  return true;
}

export async function grantCvCredits(
  writer: BillingWriter,
  input: { userId: string; source: CreditGrantSource; units: number; externalRef: string; expiresAt?: Date | null; note?: string },
): Promise<string> {
  if (isRootDatabase(writer)) return writer.transaction(tx => grantCvCredits(tx, input));
  if (!Number.isInteger(input.units) || input.units <= 0) throw new Error("Credit grant units must be a positive integer.");
  await ensureFreeEntitlement(writer, input.userId);
  const [created] = await writer.insert(creditGrants).values({
    userId: input.userId,
    source: input.source,
    units: input.units,
    remaining: input.units,
    externalRef: input.externalRef,
    expiresAt: input.expiresAt ?? null,
  }).onConflictDoNothing().returning({ id: creditGrants.id });
  if (created) await writer.insert(creditLedger).values({
    userId: input.userId,
    grantId: created.id,
    kind: "grant",
    delta: input.units,
    idempotencyKey: `grant:${input.source}:${input.externalRef}`,
    note: input.note,
  }).onConflictDoNothing();
  if (created) return created.id;
  const [existing] = await writer.select({ id: creditGrants.id }).from(creditGrants).where(and(
    eq(creditGrants.source, input.source), eq(creditGrants.externalRef, input.externalRef),
  )).limit(1);
  if (!existing) throw new Error("Credit grant could not be created.");
  return existing.id;
}

export async function updateBillingAccount(
  writer: BillingWriter,
  userId: string,
  values: Partial<Pick<typeof billingAccounts.$inferInsert,
    "plan" | "status" | "stripeCustomerId" | "stripeSubscriptionId" | "companyBlocks" |
    "currentPeriodStart" | "currentPeriodEnd" | "cancelAtPeriodEnd" | "graceEndsAt">>,
): Promise<void> {
  if (isRootDatabase(writer)) return writer.transaction(tx => updateBillingAccount(tx, userId, values));
  await ensureFreeEntitlement(writer, userId);
  await writer.update(billingAccounts).set({ ...values, updatedAt: new Date() }).where(eq(billingAccounts.userId, userId));
}

/** Apply Stripe state only when it is at least as new as the last delivery already accepted. */
export async function updateBillingAccountFromStripe(
  writer: BillingWriter,
  userId: string,
  eventCreatedAt: number,
  values: Partial<Pick<typeof billingAccounts.$inferInsert,
    "plan" | "status" | "stripeCustomerId" | "stripeSubscriptionId" | "companyBlocks" |
    "currentPeriodStart" | "currentPeriodEnd" | "cancelAtPeriodEnd" | "graceEndsAt">>,
): Promise<boolean> {
  if (isRootDatabase(writer)) return writer.transaction(tx => updateBillingAccountFromStripe(tx, userId, eventCreatedAt, values));
  await ensureFreeEntitlement(writer, userId);
  const rows = await writer.update(billingAccounts).set({ ...values, stripeEventCreatedAt: eventCreatedAt, updatedAt: new Date() })
    .where(and(eq(billingAccounts.userId, userId), lte(billingAccounts.stripeEventCreatedAt, eventCreatedAt)))
    .returning({ userId: billingAccounts.userId });
  return rows.length > 0;
}

/** Pause newest follows first so the longest-held companies stay active after capacity shrinks. */
export async function reconcileCompanyCapacity(writer: BillingWriter, userId: string, capacity: number): Promise<string[]> {
  if (isRootDatabase(writer)) return writer.transaction(tx => reconcileCompanyCapacity(tx, userId, capacity));
  const rows = await writer.select({ companyId: companySubscriptions.companyId }).from(companySubscriptions)
    .where(and(eq(companySubscriptions.userId, userId), eq(companySubscriptions.status, "active")))
    .orderBy(asc(companySubscriptions.addedAt), asc(companySubscriptions.id))
    .for("update");
  const paused = rows.slice(Math.max(0, capacity)).map(row => row.companyId);
  for (const companyId of paused) await setSubscriptionStatus(writer, userId, companyId, "paused");
  return paused;
}

/** Revoke only unspent top-up credits after a full refund or dispute. */
export async function revokeCvGrant(writer: BillingWriter, externalRef: string, note: string): Promise<number> {
  if (isRootDatabase(writer)) return writer.transaction(tx => revokeCvGrant(tx, externalRef, note));
  const [grant] = await writer.select().from(creditGrants).where(and(
    eq(creditGrants.source, "topup"), eq(creditGrants.externalRef, externalRef),
  )).limit(1).for("update");
  if (!grant || grant.remaining <= 0) return 0;
  await writer.update(creditGrants).set({ remaining: 0 }).where(eq(creditGrants.id, grant.id));
  await writer.insert(creditLedger).values({
    userId: grant.userId,
    grantId: grant.id,
    kind: "revoke",
    delta: -grant.remaining,
    idempotencyKey: `revoke:${externalRef}`,
    note: note.slice(0, 500),
  }).onConflictDoNothing();
  return grant.remaining;
}

export async function recordBillingEvent(writer: BillingWriter, eventId: string, type: string): Promise<boolean> {
  if (isRootDatabase(writer)) return writer.transaction(tx => recordBillingEvent(tx, eventId, type));
  const [created] = await writer.insert(billingEvents).values({ eventId, type }).onConflictDoNothing().returning({ eventId: billingEvents.eventId });
  return !!created;
}
