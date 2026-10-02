import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import {
  CV_TOPUPS,
  PLAN_CATALOG,
  grantCvCredits,
  reconcileCompanyCapacity,
  recordBillingEvent,
  revokeCvGrant,
  updateBillingAccount,
  updateBillingAccountFromStripe,
  type BillingPlan,
  type BillingStatus,
  type BillingWriter,
  type CvTopupKey,
} from "@ava/db";
import { billingAccounts } from "@ava/db/schema";
import { db } from "@/lib/db";
import { companyBlockPriceId, packForPrice, planForPrice, stripeClient } from "@/lib/billing/stripe";

export const runtime = "nodejs";

const idOf = (value: string | { id: string } | null | undefined): string | null =>
  typeof value === "string" ? value : value?.id ?? null;

const dateOf = (seconds: number | null | undefined): Date | null =>
  typeof seconds === "number" ? new Date(seconds * 1000) : null;

function subscriptionShape(subscription: Stripe.Subscription) {
  const base = subscription.items.data.find(item => planForPrice(item.price.id));
  const plan = planForPrice(base?.price.id);
  const blockItem = subscription.items.data.find(item => item.price.id === companyBlockPriceId());
  const status: BillingStatus = subscription.status === "canceled"
    ? "cancelled"
    : (["past_due", "unpaid", "incomplete", "incomplete_expired"].includes(subscription.status) ? "past_due" : "active");
  return {
    plan,
    status,
    companyBlocks: plan === "search" ? Math.min(5, Math.max(0, blockItem?.quantity ?? 0)) : 0,
    periodStart: dateOf(base?.current_period_start),
    periodEnd: dateOf(base?.current_period_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  };
}

/** Keep the metered add-on compatible with the plan even after a Portal plan change. */
async function normaliseCompanyBlocks(subscription: Stripe.Subscription): Promise<Stripe.Subscription> {
  const shape = subscriptionShape(subscription);
  const blockItem = subscription.items.data.find(item => item.price.id === companyBlockPriceId());
  if (!blockItem) return subscription;
  if (shape.plan === "intensive") {
    await stripeClient().subscriptionItems.del(blockItem.id, { proration_behavior: "always_invoice" });
    return stripeClient().subscriptions.retrieve(subscription.id);
  }
  if (shape.plan === "search" && (blockItem.quantity ?? 0) > 5) {
    await stripeClient().subscriptionItems.update(blockItem.id, {
      quantity: 5,
      proration_behavior: "always_invoice",
    });
    return stripeClient().subscriptions.retrieve(subscription.id);
  }
  return subscription;
}

async function accountUserId(database: BillingWriter, customerId: string | null, subscriptionId: string | null): Promise<string | null> {
  if (!customerId && !subscriptionId) return null;
  const [row] = await database.select({ userId: billingAccounts.userId }).from(billingAccounts).where(
    customerId && subscriptionId
      ? and(eq(billingAccounts.stripeCustomerId, customerId), eq(billingAccounts.stripeSubscriptionId, subscriptionId))
      : customerId
        ? eq(billingAccounts.stripeCustomerId, customerId)
        : eq(billingAccounts.stripeSubscriptionId, subscriptionId!),
  ).limit(1);
  return row?.userId ?? null;
}

async function retrieveSubscription(value: string | Stripe.Subscription | null): Promise<Stripe.Subscription | null> {
  if (!value) return null;
  if (typeof value !== "string") return value;
  return stripeClient().subscriptions.retrieve(value);
}

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  const signature = request.headers.get("stripe-signature");
  if (!secret || !signature) return NextResponse.json({ error: "Stripe webhook is not configured." }, { status: 503 });
  const body = await request.text();
  let event: Stripe.Event;
  try {
    event = stripeClient().webhooks.constructEvent(body, signature, secret);
  } catch {
    return NextResponse.json({ error: "Invalid Stripe signature." }, { status: 400 });
  }

  let subscription: Stripe.Subscription | null = null;
  let refundedCheckoutId: string | null = null;
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    subscription = await retrieveSubscription(event.data.object.subscription);
  } else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    const details = event.data.object.parent?.subscription_details;
    subscription = await retrieveSubscription(details?.subscription ?? null);
  } else if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    // Stripe does not guarantee webhook order. Reconcile the current object instead of trusting
    // the event's older snapshot; `stripe_event_created_at` is a second guard against stale writes.
    subscription = await retrieveSubscription(event.data.object.id);
  } else if (event.type === "charge.refunded" && event.data.object.amount_refunded >= event.data.object.amount) {
    const paymentIntent = idOf(event.data.object.payment_intent);
    if (paymentIntent) refundedCheckoutId = (await stripeClient().checkout.sessions.list({ payment_intent: paymentIntent, limit: 1 })).data[0]?.id ?? null;
  } else if (event.type === "charge.dispute.created") {
    const charge = typeof event.data.object.charge === "string"
      ? await stripeClient().charges.retrieve(event.data.object.charge)
      : event.data.object.charge;
    const paymentIntent = idOf(charge.payment_intent);
    if (paymentIntent) refundedCheckoutId = (await stripeClient().checkout.sessions.list({ payment_intent: paymentIntent, limit: 1 })).data[0]?.id ?? null;
  }

  if (subscription && subscription.status !== "canceled") subscription = await normaliseCompanyBlocks(subscription);

  await db().transaction(async tx => {
    if (!(await recordBillingEvent(tx, event.id, event.type))) return;

    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object;
      const userId = session.metadata?.userId || session.client_reference_id;
      if (!userId) return;
      const customerId = idOf(session.customer);
      if (session.metadata?.purchase === "cv_topup" && session.payment_status === "paid") {
        const pack = session.metadata.pack as CvTopupKey;
        if (!(pack in CV_TOPUPS)) return;
        const expected = CV_TOPUPS[pack].priceGbp * 100;
        if (session.currency !== "gbp" || session.amount_total !== expected) return;
        await grantCvCredits(tx, {
          userId,
          source: "topup",
          units: CV_TOPUPS[pack].credits,
          externalRef: session.id,
          note: `${CV_TOPUPS[pack].credits} CV credit top-up`,
        });
        if (customerId) await updateBillingAccount(tx, userId, { stripeCustomerId: customerId });
        return;
      }
      if (session.metadata?.purchase === "plan" && subscription) {
        const shape = subscriptionShape(subscription);
        if (!shape.plan) return;
        await updateBillingAccountFromStripe(tx, userId, event.created, {
          plan: shape.plan,
          status: shape.status,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscription.id,
          companyBlocks: shape.companyBlocks,
          currentPeriodStart: shape.periodStart,
          currentPeriodEnd: shape.periodEnd,
          cancelAtPeriodEnd: shape.cancelAtPeriodEnd,
          graceEndsAt: null,
        });
      }
      return;
    }

    if (subscription && (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted")) {
      const customerId = idOf(subscription.customer);
      const userId = subscription.metadata.userId || await accountUserId(tx, customerId, subscription.id);
      if (!userId) return;
      const shape = subscriptionShape(subscription);
      const [current] = shape.status === "past_due"
        ? await tx.select({ graceEndsAt: billingAccounts.graceEndsAt }).from(billingAccounts).where(eq(billingAccounts.userId, userId)).limit(1)
        : [];
      const accepted = await updateBillingAccountFromStripe(tx, userId, event.created, {
        plan: shape.plan ?? "free",
        status: shape.status,
        stripeCustomerId: customerId,
        stripeSubscriptionId: shape.status === "cancelled" ? null : subscription.id,
        companyBlocks: shape.status === "cancelled" ? 0 : shape.companyBlocks,
        currentPeriodStart: shape.periodStart,
        currentPeriodEnd: shape.periodEnd,
        cancelAtPeriodEnd: shape.cancelAtPeriodEnd,
        graceEndsAt: shape.status === "past_due" ? current?.graceEndsAt ?? new Date(event.created * 1000 + 7 * 86_400_000) : null,
      });
      if (accepted && (shape.status === "cancelled" || shape.plan)) {
        const graceExpired = shape.status === "past_due" && !!current?.graceEndsAt && current.graceEndsAt <= new Date(event.created * 1000);
        const capacity = shape.status === "cancelled" || graceExpired ? PLAN_CATALOG.free.includedCompanies
          : Math.min(PLAN_CATALOG[shape.plan!].maxCompanies, PLAN_CATALOG[shape.plan!].includedCompanies + shape.companyBlocks * 10);
        await reconcileCompanyCapacity(tx, userId, capacity);
      }
      return;
    }

    if ((event.type === "invoice.paid" || event.type === "invoice.payment_failed") && subscription) {
      const invoice = event.data.object;
      const customerId = idOf(invoice.customer);
      const userId = invoice.parent?.subscription_details?.metadata?.userId || subscription.metadata.userId || await accountUserId(tx, customerId, subscription.id);
      if (!userId) return;
      const shape = subscriptionShape(subscription);
      if (event.type === "invoice.payment_failed") {
        if (shape.status === "active") return; // A later recovery already restored the subscription.
        const [current] = await tx.select({ graceEndsAt: billingAccounts.graceEndsAt }).from(billingAccounts).where(eq(billingAccounts.userId, userId)).limit(1);
        const graceEndsAt = current?.graceEndsAt ?? new Date(event.created * 1000 + 7 * 86_400_000);
        const accepted = await updateBillingAccountFromStripe(tx, userId, event.created, {
          status: "past_due",
          graceEndsAt,
        });
        if (accepted && graceEndsAt <= new Date(event.created * 1000)) {
          await reconcileCompanyCapacity(tx, userId, PLAN_CATALOG.free.includedCompanies);
        }
        return;
      }
      if (!shape.plan || shape.status !== "active") return;
      const accepted = await updateBillingAccountFromStripe(tx, userId, event.created, {
        plan: shape.plan,
        status: shape.status,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id,
        companyBlocks: shape.companyBlocks,
        currentPeriodStart: shape.periodStart,
        currentPeriodEnd: shape.periodEnd,
        cancelAtPeriodEnd: shape.cancelAtPeriodEnd,
        graceEndsAt: null,
      });
      if (accepted && shape.periodStart && shape.periodEnd) await grantMonthlyCredits(tx, userId, shape.plan, subscription.id, shape.periodStart, shape.periodEnd);
    }
    if (refundedCheckoutId && (event.type === "charge.refunded" || event.type === "charge.dispute.created")) {
      await revokeCvGrant(tx, refundedCheckoutId, event.type === "charge.refunded" ? "CV top-up refunded" : "CV top-up payment disputed");
    }
  });

  return NextResponse.json({ received: true });
}

async function grantMonthlyCredits(
  tx: Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0],
  userId: string,
  plan: Exclude<BillingPlan, "free">,
  subscriptionId: string,
  periodStart: Date,
  periodEnd: Date,
) {
  const units = PLAN_CATALOG[plan].monthlyCvCredits;
  if (!units) return;
  const periodMs = Math.max(0, periodEnd.getTime() - periodStart.getTime());
  await grantCvCredits(tx, {
    userId,
    source: "monthly",
    units,
    externalRef: `${subscriptionId}:${periodStart.toISOString()}`,
    expiresAt: new Date(periodEnd.getTime() + periodMs),
    note: `${PLAN_CATALOG[plan].label} monthly CV credits`,
  });
}
