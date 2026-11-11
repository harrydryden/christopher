import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "./client";
import { ensureFreeEntitlement } from "./billing";
import { billingAccounts, creditGrants, creditLedger, creditReservations, cvAiUsage, cvApplicationContexts,
  cvAutoBaselines, cvDrafts, cvOpportunities, users, type BillingPlan } from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type CvAiAction = typeof cvAiUsage.$inferInsert["action"];
export type CvAiSource = { kind: "draft" | "inline_run" | "skills_run"; id: string };
export const CV_AI_PRICE_VERSION = 1;
export const CV_AI_UNITS: Record<CvAiAction, number> = {
  inline_correction: 1, inline_refine: 2, inline_tailor: 3, skills: 3, check: 2, whole_cv: 8,
};
export const CV_AI_LIMITS: Record<BillingPlan, { session: number; week: number }> = {
  free: { session: 8, week: 24 }, search: { session: 24, week: 100 },
  intensive: { session: 48, week: 250 },
};
const FIVE_HOURS = 5 * 60 * 60 * 1000;
const WEEK = 7 * 24 * 60 * 60 * 1000;

export class CvAiUsageError extends Error {
  readonly userFacing = true as const;
  constructor(readonly code: "source" | "request_conflict" | "role_in_flight" | "credits" | "session_limit" | "week_limit" | "released",
    message: string, readonly resetAt?: Date) { super(message); this.name = "CvAiUsageError"; }
}

async function lockBilling(tx: Tx, userId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:${userId}`}, 0))`);
}

async function legacyProof(tx: Tx, userId: string, jobId: string | null,
  contextId: string | null, ancestorIds: string[]) {
  const [baseline] = await tx.select({ id: cvAutoBaselines.id, at: cvAutoBaselines.publishedAt })
    .from(cvAutoBaselines).innerJoin(cvApplicationContexts, eq(cvApplicationContexts.id, cvAutoBaselines.contextId))
    .innerJoin(creditReservations, eq(creditReservations.draftId, cvAutoBaselines.sourceDraftId))
    .where(and(eq(cvAutoBaselines.userId, userId), eq(cvAutoBaselines.status, "ready"),
      eq(creditReservations.status, "consumed"),
      jobId ? eq(cvApplicationContexts.jobId, jobId) : eq(cvAutoBaselines.contextId, contextId!)))
    .orderBy(cvAutoBaselines.publishedAt).limit(1);
  if (baseline) return { id: baseline.id, at: baseline.at ?? new Date(), proof: `auto_baseline:${baseline.id}` };
  const [ready] = await tx.select({ id: cvDrafts.id, at: cvDrafts.createdAt })
    .from(cvDrafts).innerJoin(creditReservations, eq(creditReservations.draftId, cvDrafts.id))
    .where(and(eq(cvDrafts.userId, userId), eq(cvDrafts.status, "ready"),
      eq(creditReservations.status, "consumed"),
      sql`${cvDrafts.content} is not null`,
      or(isNull(cvDrafts.editingMode), eq(cvDrafts.editingMode, "auto"),
        and(eq(cvDrafts.editingMode, "refine"), eq(cvDrafts.refinementOriginKind, "baseline"))),
      jobId ? eq(cvDrafts.jobId, jobId) : contextId ? eq(cvDrafts.contextId, contextId) : inArray(cvDrafts.id, ancestorIds)))
    .orderBy(cvDrafts.createdAt).limit(1);
  if (ready) return { id: ready.id, at: ready.at, proof: `ready_draft:${ready.id}` };
  return null;
}

/** Source ownership is checked before creating an account-scoped entitlement. */
export async function ensureCvOpportunityForContext(tx: Tx, input: { userId: string; contextId: string }) {
  const [context] = await tx.select().from(cvApplicationContexts)
    .where(and(eq(cvApplicationContexts.id, input.contextId), eq(cvApplicationContexts.userId, input.userId)))
    .for("update");
  if (!context) throw new CvAiUsageError("source", "This application is unavailable. Reload it before requesting AI help.");
  // Context first, then billing, then opportunity: settlement never takes a context lock.
  await lockBilling(tx, input.userId);
  let opportunity = context.opportunityId ? (await tx.select().from(cvOpportunities)
    .where(and(eq(cvOpportunities.id, context.opportunityId), eq(cvOpportunities.userId, input.userId))).limit(1))[0] : null;
  if (!opportunity) {
    const [created] = await tx.insert(cvOpportunities).values({ userId: input.userId, jobId: context.jobId })
      .onConflictDoNothing().returning();
    opportunity = created ?? (context.jobId ? (await tx.select().from(cvOpportunities)
      .where(and(eq(cvOpportunities.userId, input.userId), eq(cvOpportunities.jobId, context.jobId))).limit(1))[0] : null);
    if (!opportunity) throw new Error("CV opportunity claim was not available.");
    await tx.update(cvApplicationContexts).set({ opportunityId: opportunity.id })
      .where(and(eq(cvApplicationContexts.id, context.id), eq(cvApplicationContexts.userId, input.userId)));
  }
  if (opportunity.jobId !== context.jobId && context.jobId)
    throw new CvAiUsageError("source", "This application is attached to a different role.");
  if (!opportunity.firstSuccessAt) {
    const proof = await legacyProof(tx, input.userId, context.jobId, context.id, []);
    if (proof) {
      const [updated] = await tx.update(cvOpportunities).set({ firstSuccessOperationId: proof.id,
        firstSuccessAt: proof.at, grandfatherProof: proof.proof })
        .where(and(eq(cvOpportunities.id, opportunity.id), isNull(cvOpportunities.firstSuccessAt))).returning();
      opportunity = updated ?? opportunity;
    }
  }
  return { opportunityId: opportunity.id, access: opportunity.firstSuccessAt ? "unlocked" as const : "pending" as const };
}

/** Old drafts without a context use their posting, or their exact parent lineage. */
export async function ensureCvOpportunityForDraft(tx: Tx, input: { userId: string; draftId: string }):
  Promise<{ opportunityId: string; access: "pending" | "unlocked" }> {
  const [draft] = await tx.select({ id: cvDrafts.id, userId: cvDrafts.userId, contextId: cvDrafts.contextId,
    jobId: cvDrafts.jobId, opportunityId: cvDrafts.opportunityId, parentId: cvDrafts.parentId })
    .from(cvDrafts).where(and(eq(cvDrafts.id, input.draftId), eq(cvDrafts.userId, input.userId))).limit(1);
  if (!draft) throw new CvAiUsageError("source", "This CV is unavailable. Reload it before requesting AI help.");
  if (draft.opportunityId) {
    const [opportunity] = await tx.select().from(cvOpportunities)
      .where(and(eq(cvOpportunities.id, draft.opportunityId), eq(cvOpportunities.userId, input.userId))).limit(1);
    if (!opportunity) throw new CvAiUsageError("source", "This CV's role is unavailable.");
    return { opportunityId: opportunity.id, access: opportunity.firstSuccessAt ? "unlocked" as const : "pending" as const };
  }
  if (draft.contextId) {
    const result = await ensureCvOpportunityForContext(tx, { userId: input.userId, contextId: draft.contextId });
    await tx.update(cvDrafts).set({ opportunityId: result.opportunityId }).where(eq(cvDrafts.id, draft.id));
    return result;
  }
  if (draft.jobId) {
    await lockBilling(tx, input.userId);
    const [created] = await tx.insert(cvOpportunities).values({ userId: input.userId, jobId: draft.jobId })
      .onConflictDoNothing().returning();
    const opportunity = created ?? (await tx.select().from(cvOpportunities)
      .where(and(eq(cvOpportunities.userId, input.userId), eq(cvOpportunities.jobId, draft.jobId))).limit(1))[0];
    if (!opportunity) throw new Error("CV opportunity claim was not available.");
    await tx.update(cvDrafts).set({ opportunityId: opportunity.id }).where(eq(cvDrafts.id, draft.id));
    if (!opportunity.firstSuccessAt) {
      const proof = await legacyProof(tx, input.userId, draft.jobId, null, []);
      if (proof) await tx.update(cvOpportunities).set({ firstSuccessOperationId: proof.id,
        firstSuccessAt: proof.at, grandfatherProof: proof.proof })
        .where(and(eq(cvOpportunities.id, opportunity.id), isNull(cvOpportunities.firstSuccessAt)));
    }
    const [current] = await tx.select().from(cvOpportunities).where(eq(cvOpportunities.id, opportunity.id));
    return { opportunityId: opportunity.id, access: current?.firstSuccessAt ? "unlocked" as const : "pending" as const };
  }
  const seen = new Set<string>();
  let root = draft;
  while (root.parentId) {
    if (seen.size >= 512 || seen.has(root.id)) throw new CvAiUsageError("source", "This older CV's history needs review before another AI request.");
    seen.add(root.id);
    const [parent] = await tx.select({ id: cvDrafts.id, userId: cvDrafts.userId, contextId: cvDrafts.contextId,
      jobId: cvDrafts.jobId, opportunityId: cvDrafts.opportunityId, parentId: cvDrafts.parentId })
      .from(cvDrafts).where(and(eq(cvDrafts.id, root.parentId), eq(cvDrafts.userId, input.userId))).limit(1);
    if (!parent) break;
    root = parent;
    if (root.opportunityId) break;
  }
  if (root.opportunityId) {
    await tx.update(cvDrafts).set({ opportunityId: root.opportunityId }).where(eq(cvDrafts.id, draft.id));
    const [opportunity] = await tx.select().from(cvOpportunities).where(and(eq(cvOpportunities.id, root.opportunityId), eq(cvOpportunities.userId, input.userId)));
    if (!opportunity) throw new CvAiUsageError("source", "This older CV's role is unavailable.");
    return { opportunityId: opportunity.id, access: opportunity.firstSuccessAt ? "unlocked" as const : "pending" as const };
  }
  if (root.id !== draft.id && (root.contextId || root.jobId)) {
    const result = await ensureCvOpportunityForDraft(tx, { userId: input.userId, draftId: root.id });
    await tx.update(cvDrafts).set({ opportunityId: result.opportunityId }).where(eq(cvDrafts.id, draft.id));
    return result;
  }
  await lockBilling(tx, input.userId);
  const [created] = await tx.insert(cvOpportunities).values({ userId: input.userId, legacyRootDraftId: root.id })
    .onConflictDoNothing().returning();
  const opportunity = created ?? (await tx.select().from(cvOpportunities)
    .where(and(eq(cvOpportunities.userId, input.userId), eq(cvOpportunities.legacyRootDraftId, root.id))).limit(1))[0];
  if (!opportunity) throw new Error("CV opportunity claim was not available.");
  await tx.update(cvDrafts).set({ opportunityId: opportunity.id }).where(eq(cvDrafts.id, draft.id));
  if (!opportunity.firstSuccessAt) {
    const proof = await legacyProof(tx, input.userId, null, null, [draft.id, root.id, ...seen]);
    if (proof) await tx.update(cvOpportunities).set({ firstSuccessOperationId: proof.id,
      firstSuccessAt: proof.at, grandfatherProof: proof.proof })
      .where(and(eq(cvOpportunities.id, opportunity.id), isNull(cvOpportunities.firstSuccessAt)));
  }
  const [current] = await tx.select().from(cvOpportunities).where(eq(cvOpportunities.id, opportunity.id));
  return { opportunityId: opportunity.id, access: current?.firstSuccessAt ? "unlocked" as const : "pending" as const };
}

export async function attachCvOpportunityToContext(tx: Tx, input: { userId: string; contextId: string; opportunityId: string }) {
  const [context] = await tx.select().from(cvApplicationContexts).where(and(eq(cvApplicationContexts.id, input.contextId),
    eq(cvApplicationContexts.userId, input.userId))).for("update");
  const [opportunity] = await tx.select().from(cvOpportunities).where(and(eq(cvOpportunities.id, input.opportunityId),
    eq(cvOpportunities.userId, input.userId))).limit(1);
  if (!context || !opportunity || (context.jobId && context.jobId !== opportunity.jobId))
    throw new CvAiUsageError("source", "Choose an opportunity belonging to this account and role.");
  if (context.opportunityId && context.opportunityId !== opportunity.id)
    throw new CvAiUsageError("source", "This application is already attached to another opportunity.");
  await tx.update(cvApplicationContexts).set({ opportunityId: opportunity.id }).where(eq(cvApplicationContexts.id, context.id));
  return opportunity.id;
}

/** A quote is advisory; admission repeats it under the lock and fences the displayed price. */
export async function quoteCvAiAction(db: Db, input: { userId: string;
  source: { kind: "context"; id: string } | { kind: "draft"; id: string }; action: CvAiAction }) {
  const access = await db.transaction(tx => input.source.kind === "context"
    ? ensureCvOpportunityForContext(tx, { userId: input.userId, contextId: input.source.id })
    : ensureCvOpportunityForDraft(tx, { userId: input.userId, draftId: input.source.id }));
  return { opportunityId: access.opportunityId, charge: access.access === "pending"
    ? "role_credit" as const : "allowance" as const,
    units: access.access === "pending" ? 0 : CV_AI_UNITS[input.action],
    priceVersion: CV_AI_PRICE_VERSION };
}

function effectivePlan(account: typeof billingAccounts.$inferSelect, now: Date): BillingPlan {
  if (account.status === "cancelled" || (account.status === "past_due" && account.graceEndsAt && account.graceEndsAt <= now))
    return "free";
  return account.plan;
}

function weekFor(createdAt: Date, now: Date) {
  const intervals = Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / WEEK));
  return new Date(createdAt.getTime() + intervals * WEEK);
}

export async function reserveCvAiUsage(tx: Tx, input: { userId: string; opportunityId: string;
  operationId: string; requestKey: string; inputHash: string; action: CvAiAction; source: CvAiSource;
  expectedCharge?: "role_credit" | "allowance"; expectedUnits?: number; expectedPriceVersion?: number;
  now?: Date }) {
  const now = input.now ?? new Date();
  if (!/^[a-f0-9]{64}$/i.test(input.inputHash) || !input.requestKey || input.requestKey.length > 160)
    throw new CvAiUsageError("request_conflict", "Reload this AI request before trying again.");
  await ensureFreeEntitlement(tx, input.userId); // Takes the account billing lock.
  const [opportunity] = await tx.select().from(cvOpportunities)
    .where(and(eq(cvOpportunities.id, input.opportunityId), eq(cvOpportunities.userId, input.userId))).for("update");
  if (!opportunity) throw new CvAiUsageError("source", "This role is unavailable. Reload it before requesting AI help.");
  const [existing] = await tx.select().from(cvAiUsage)
    .where(and(eq(cvAiUsage.userId, input.userId), eq(cvAiUsage.requestKey, input.requestKey))).limit(1);
  if (existing) {
    if (existing.id !== input.operationId || existing.opportunityId !== input.opportunityId ||
      existing.inputHash !== input.inputHash || existing.action !== input.action ||
      existing.sourceKind !== input.source.kind || existing.sourceId !== input.source.id)
      throw new CvAiUsageError("request_conflict", "This request key was already used for different AI work. Reload before trying again.");
    if ((input.expectedCharge && existing.chargeKind !== input.expectedCharge) ||
      (input.expectedUnits !== undefined && existing.units !== input.expectedUnits) ||
      (input.expectedPriceVersion !== undefined && existing.priceVersion !== input.expectedPriceVersion))
      throw new CvAiUsageError("request_conflict", "The quoted AI cost changed. Reload before requesting this work.");
    return { usageId: existing.id, charge: existing.chargeKind, units: existing.units,
      status: existing.status === "reserved" ? "in_flight" as const : existing.status === "consumed" ? "replay" as const : "released" as const,
      sessionResetAt: existing.fiveHourStart ? new Date(existing.fiveHourStart.getTime() + FIVE_HOURS) : null,
      weekResetAt: existing.weekStart ? new Date(existing.weekStart.getTime() + WEEK) : null };
  }
  const charge = opportunity.firstSuccessAt ? "allowance" : "role_credit";
  const quotedUnits = charge === "role_credit" ? 0 : CV_AI_UNITS[input.action];
  if ((input.expectedCharge && input.expectedCharge !== charge) ||
    (input.expectedUnits !== undefined && input.expectedUnits !== quotedUnits) ||
    (input.expectedPriceVersion !== undefined && input.expectedPriceVersion !== CV_AI_PRICE_VERSION))
    throw new CvAiUsageError("request_conflict", "The quoted AI cost changed. Reload before requesting this work.");
  if (!opportunity.firstSuccessAt) {
    // A pre-cutover worker may still hold the first role credit in the old ledger. The new
    // admission shares the account billing lock with its settlement; it must wait rather than
    // reserve a second first-role credit through a duplicate application context.
    const legacyInFlight = await tx.execute<{ draft_id: string }>(sql`
      select cr.draft_id from credit_reservations cr
      join cv_drafts d on d.id = cr.draft_id
      left join cv_application_contexts c on c.id = d.context_id
      where cr.user_id = ${input.userId}::uuid and cr.status = 'reserved'
        and ((${opportunity.jobId}::uuid is not null and d.job_id = ${opportunity.jobId}::uuid)
          or d.opportunity_id = ${opportunity.id}::uuid
          or c.opportunity_id = ${opportunity.id}::uuid)
      limit 1`);
    if (legacyInFlight.rows.length)
      throw new CvAiUsageError("role_in_flight", "AI help is already being prepared for this role. Wait for that request to finish, then try again.");
    const [claim] = await tx.select({ id: cvAiUsage.id }).from(cvAiUsage)
      .where(and(eq(cvAiUsage.opportunityId, opportunity.id), eq(cvAiUsage.chargeKind, "role_credit"),
        eq(cvAiUsage.status, "reserved"))).limit(1);
    if (claim) throw new CvAiUsageError("role_in_flight", "AI help is already being prepared for this role. Wait for that request to finish, then try again.");
    const [grant] = await tx.select({ id: creditGrants.id }).from(creditGrants).where(and(
      eq(creditGrants.userId, input.userId), gt(creditGrants.remaining, 0),
      or(isNull(creditGrants.expiresAt), gt(creditGrants.expiresAt, now)),
    )).orderBy(sql`${creditGrants.expiresAt} asc nulls last`,
      sql`case ${creditGrants.source} when 'monthly' then 0 when 'welcome' then 1 when 'topup' then 2 else 3 end`,
      creditGrants.createdAt).limit(1).for("update");
    if (!grant) throw new CvAiUsageError("credits", "You have no role credits available. Add one in Account to request AI help.");
    await tx.update(creditGrants).set({ remaining: sql`${creditGrants.remaining} - 1` }).where(eq(creditGrants.id, grant.id));
    await tx.insert(cvAiUsage).values({ id: input.operationId, userId: input.userId, opportunityId: opportunity.id,
      requestKey: input.requestKey, inputHash: input.inputHash, action: input.action,
      priceVersion: CV_AI_PRICE_VERSION, chargeKind: "role_credit", units: 0, grantId: grant.id,
      sourceKind: input.source.kind, sourceId: input.source.id, reservedAt: now });
    await tx.insert(creditLedger).values({ userId: input.userId, grantId: grant.id,
      draftId: input.source.kind === "draft" ? input.source.id : null,
      kind: "reserve", delta: -1, idempotencyKey: `reserve-ai:${input.operationId}` });
    return { usageId: input.operationId, charge: "role_credit" as const, units: 0,
      status: "reserved" as const, sessionResetAt: null, weekResetAt: null };
  }
  const [account] = await tx.select().from(billingAccounts).where(eq(billingAccounts.userId, input.userId)).limit(1);
  const [person] = await tx.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, input.userId)).limit(1);
  if (!account || !person) throw new CvAiUsageError("source", "This account is unavailable.");
  const limits = CV_AI_LIMITS[effectivePlan(account, now)];
  const units = CV_AI_UNITS[input.action];
  const weekStart = weekFor(person.createdAt, now);
  const [last] = await tx.select({ start: cvAiUsage.fiveHourStart }).from(cvAiUsage)
    .where(and(eq(cvAiUsage.userId, input.userId), eq(cvAiUsage.chargeKind, "allowance"),
      sql`${cvAiUsage.fiveHourStart} is not null`))
    .orderBy(desc(cvAiUsage.fiveHourStart)).limit(1);
  const fiveHourStart = last?.start && now.getTime() < last.start.getTime() + FIVE_HOURS ? last.start : now;
  const totals = await tx.execute<{ session: number; week: number }>(sql`
    select coalesce(sum(units) filter (where five_hour_start = ${fiveHourStart}), 0)::int as session,
      coalesce(sum(units) filter (where week_start = ${weekStart}), 0)::int as week
    from cv_ai_usage where user_id = ${input.userId}::uuid and charge_kind = 'allowance'
      and status in ('reserved','consumed')
      and (five_hour_start = ${fiveHourStart} or week_start = ${weekStart})`);
  const used = totals.rows[0] ?? { session: 0, week: 0 };
  if (Number(used.session) + units > limits.session)
    throw new CvAiUsageError("session_limit", "This five-hour AI allowance is full. You can keep editing freely or try again when it resets.",
      new Date(fiveHourStart.getTime() + FIVE_HOURS));
  if (Number(used.week) + units > limits.week)
    throw new CvAiUsageError("week_limit", "This week's AI allowance is full. You can keep editing freely or try again when it resets.",
      new Date(weekStart.getTime() + WEEK));
  await tx.insert(cvAiUsage).values({ id: input.operationId, userId: input.userId, opportunityId: opportunity.id,
    requestKey: input.requestKey, inputHash: input.inputHash, action: input.action,
    priceVersion: CV_AI_PRICE_VERSION, chargeKind: "allowance", units, sourceKind: input.source.kind,
    sourceId: input.source.id, fiveHourStart, weekStart, reservedAt: now });
  return { usageId: input.operationId, charge: "allowance" as const, units,
    status: "reserved" as const, sessionResetAt: new Date(fiveHourStart.getTime() + FIVE_HOURS),
    weekResetAt: new Date(weekStart.getTime() + WEEK) };
}

/** Must run in the transaction that durably publishes or rejects the output. */
export async function settleCvAiUsage(tx: Tx, input: { usageId: string; source: CvAiSource;
  outcome: "ready" | "failed" | "cancelled"; now?: Date }) {
  const now = input.now ?? new Date();
  const [probe] = await tx.select({ userId: cvAiUsage.userId, opportunityId: cvAiUsage.opportunityId })
    .from(cvAiUsage).where(eq(cvAiUsage.id, input.usageId)).limit(1);
  if (!probe) return false;
  await lockBilling(tx, probe.userId);
  const [opportunity] = await tx.select().from(cvOpportunities).where(and(eq(cvOpportunities.id, probe.opportunityId),
    eq(cvOpportunities.userId, probe.userId))).for("update");
  if (!opportunity) throw new CvAiUsageError("source", "This role is unavailable.");
  const [usage] = await tx.select().from(cvAiUsage).where(eq(cvAiUsage.id, input.usageId)).for("update");
  if (!usage || usage.status !== "reserved") return false;
  if (usage.sourceKind !== input.source.kind || usage.sourceId !== input.source.id)
    throw new CvAiUsageError("source", "This AI result belongs to another request.");
  if (input.outcome === "ready") {
    if (usage.chargeKind === "role_credit") {
      const [revoked] = await tx.select({ id: creditLedger.id }).from(creditLedger)
        .where(and(eq(creditLedger.grantId, usage.grantId!), eq(creditLedger.kind, "revoke"))).limit(1);
      if (revoked) throw new CvAiUsageError("credits", "The role credit for this request was refunded. Request a new credit before continuing.");
      if (opportunity.firstSuccessAt && opportunity.firstSuccessOperationId !== usage.id)
        throw new CvAiUsageError("source", "This role's first AI result was already published.");
      await tx.update(cvOpportunities).set({ firstSuccessOperationId: usage.id, firstSuccessAt: now })
        .where(eq(cvOpportunities.id, opportunity.id));
      await tx.insert(creditLedger).values({ userId: usage.userId, grantId: usage.grantId,
        draftId: usage.sourceKind === "draft" ? usage.sourceId : null,
        kind: "consume", delta: 0, idempotencyKey: `consume-ai:${usage.id}` });
    }
    await tx.update(cvAiUsage).set({ status: "consumed", settledAt: now }).where(eq(cvAiUsage.id, usage.id));
  } else {
    if (usage.chargeKind === "role_credit" && usage.grantId) {
      const [revoked] = await tx.select({ id: creditLedger.id }).from(creditLedger)
        .where(and(eq(creditLedger.grantId, usage.grantId), eq(creditLedger.kind, "revoke"))).limit(1);
      if (!revoked) await tx.update(creditGrants).set({ remaining: sql`${creditGrants.remaining} + 1` }).where(eq(creditGrants.id, usage.grantId));
      await tx.insert(creditLedger).values({ userId: usage.userId, grantId: usage.grantId,
        draftId: usage.sourceKind === "draft" ? usage.sourceId : null,
        kind: "release", delta: revoked ? 0 : 1, idempotencyKey: `release-ai:${usage.id}` });
    }
    await tx.update(cvAiUsage).set({ status: "released", settledAt: now }).where(eq(cvAiUsage.id, usage.id));
  }
  return true;
}

export async function getCvAiAllowance(db: Db, userId: string, now = new Date()) {
  await ensureFreeEntitlement(db, userId);
  const [account] = await db.select().from(billingAccounts).where(eq(billingAccounts.userId, userId)).limit(1);
  const [person] = await db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId)).limit(1);
  if (!account || !person) throw new CvAiUsageError("source", "This account is unavailable.");
  const plan = effectivePlan(account, now), limits = CV_AI_LIMITS[plan];
  const weekStart = weekFor(person.createdAt, now);
  const [last] = await db.select({ start: cvAiUsage.fiveHourStart }).from(cvAiUsage)
    .where(and(eq(cvAiUsage.userId, userId), eq(cvAiUsage.chargeKind, "allowance"),
      sql`${cvAiUsage.fiveHourStart} is not null`)).orderBy(desc(cvAiUsage.fiveHourStart)).limit(1);
  const sessionStart = last?.start && now.getTime() < last.start.getTime() + FIVE_HOURS ? last.start : null;
  const totals = await db.execute<{ sessionUsed: number; sessionReserved: number; weekUsed: number; weekReserved: number }>(sql`
    select coalesce(sum(units) filter (where five_hour_start = ${sessionStart} and status = 'consumed'), 0)::int as "sessionUsed",
      coalesce(sum(units) filter (where five_hour_start = ${sessionStart} and status = 'reserved'), 0)::int as "sessionReserved",
      coalesce(sum(units) filter (where week_start = ${weekStart} and status = 'consumed'), 0)::int as "weekUsed",
      coalesce(sum(units) filter (where week_start = ${weekStart} and status = 'reserved'), 0)::int as "weekReserved"
    from cv_ai_usage where user_id = ${userId}::uuid and charge_kind = 'allowance'
      and (week_start = ${weekStart} or five_hour_start = ${sessionStart})`);
  const counts = totals.rows[0] ?? { sessionUsed: 0, sessionReserved: 0, weekUsed: 0, weekReserved: 0 };
  return { plan, priceVersion: CV_AI_PRICE_VERSION,
    session: { limit: limits.session, used: Number(counts.sessionUsed), reserved: Number(counts.sessionReserved),
      resetAt: sessionStart ? new Date(sessionStart.getTime() + FIVE_HOURS) : null },
    week: { limit: limits.week, used: Number(counts.weekUsed), reserved: Number(counts.weekReserved),
      resetAt: new Date(weekStart.getTime() + WEEK) } };
}

/** Compatibility bridge for CV draft actions that predate opportunity accounting. */
export async function reserveCvAiUsageForDraft(tx: Tx, input: { userId: string; draftId: string;
  action?: CvAiAction; now?: Date;
  expectedQuote?: { charge: "role_credit" | "allowance"; units: number; priceVersion: number } }) {
  const owned = await ensureCvOpportunityForDraft(tx, input);
  await lockBilling(tx, input.userId);
  const [active] = await tx.select().from(cvAiUsage).where(and(eq(cvAiUsage.userId, input.userId),
    eq(cvAiUsage.sourceKind, "draft"), eq(cvAiUsage.sourceId, input.draftId), eq(cvAiUsage.status, "reserved")))
    .limit(1);
  if (active) {
    if (input.expectedQuote && (active.chargeKind !== input.expectedQuote.charge ||
      active.units !== input.expectedQuote.units || active.priceVersion !== input.expectedQuote.priceVersion))
      throw new CvAiUsageError("request_conflict", "The quoted AI cost changed. Reload before requesting this work.");
    return active;
  }
  const [count] = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from cv_ai_usage
    where user_id = ${input.userId}::uuid and source_kind = 'draft' and source_id = ${input.draftId}::uuid`)).rows;
  const action = input.action ?? "whole_cv";
  const attempt = Number(count?.n ?? 0) + 1;
  const operationId = randomUUID();
  const requestKey = `cv-draft:${input.draftId}:${attempt}`;
  const inputHash = createHash("sha256").update(JSON.stringify({ draftId: input.draftId, action, attempt })).digest("hex");
  await reserveCvAiUsage(tx, { userId: input.userId, opportunityId: owned.opportunityId,
    operationId, requestKey, inputHash, action, source: { kind: "draft", id: input.draftId }, now: input.now,
    expectedCharge: input.expectedQuote?.charge, expectedUnits: input.expectedQuote?.units,
    expectedPriceVersion: input.expectedQuote?.priceVersion });
  const [usage] = await tx.select().from(cvAiUsage).where(eq(cvAiUsage.id, operationId));
  return usage!;
}

export async function settleCvAiUsageForDraft(tx: Tx, draftId: string, outcome: "ready" | "failed" | "cancelled", now?: Date) {
  const [usage] = await tx.select().from(cvAiUsage).where(and(eq(cvAiUsage.sourceKind, "draft"),
    eq(cvAiUsage.sourceId, draftId), eq(cvAiUsage.status, "reserved"))).orderBy(desc(cvAiUsage.reservedAt)).limit(1);
  if (!usage) return false;
  return settleCvAiUsage(tx, { usageId: usage.id, source: { kind: "draft", id: draftId }, outcome, now });
}

export async function transferCvAiUsageForDraft(tx: Tx, fromDraftId: string, toDraftId: string) {
  const [usage] = await tx.select().from(cvAiUsage).where(and(eq(cvAiUsage.sourceKind, "draft"),
    eq(cvAiUsage.sourceId, fromDraftId), eq(cvAiUsage.status, "reserved"))).for("update");
  if (!usage) return false;
  await tx.update(cvAiUsage).set({ sourceId: toDraftId }).where(eq(cvAiUsage.id, usage.id));
  return true;
}
