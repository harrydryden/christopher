import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import {
  CV_TOPUPS,
  PLAN_CATALOG,
  grantCvCredits,
  recordBillingEvent,
  updateBillingAccount,
  type BillingPlan,
  type BillingStatus,
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
    companyBlocks: Math.max(0, blockItem?.quantity ?? 0),
    periodStart: dateOf(base?.current_period_start),
    periodEnd: dateOf(base?.current_period_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  };
}

async function accountUserId(customerId: string | null, subscriptionId: string | null): Promise<string | null> {
  if (!customerId && !subscriptionId) return null;
  const [row] = await db().select({ userId: billingAccounts.userId }).from(billingAccounts).where(
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
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    subscription = await retrieveSubscription(event.data.object.subscription);
  } else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    const details = event.data.object.parent?.subscription_details;
    subscription = await retrieveSubscription(details?.subscription ?? null);
  } else if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    subscription = event.data.object;
  }

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
        await updateBillingAccount(tx, userId, {
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
        if (shape.periodStart && shape.periodEnd) await grantMonthlyCredits(tx, userId, shape.plan, subscription.id, shape.periodStart, shape.periodEnd);
      }
      return;
    }

    if (subscription && (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted")) {
      const customerId = idOf(subscription.customer);
      const userId = subscription.metadata.userId || await accountUserId(customerId, subscription.id);
      if (!userId) return;
      const shape = subscriptionShape(subscription);
      await updateBillingAccount(tx, userId, {
        plan: shape.plan ?? "free",
        status: shape.status,
        stripeCustomerId: customerId,
        stripeSubscriptionId: shape.status === "cancelled" ? null : subscription.id,
        companyBlocks: shape.status === "cancelled" ? 0 : shape.companyBlocks,
        currentPeriodStart: shape.periodStart,
        currentPeriodEnd: shape.periodEnd,
        cancelAtPeriodEnd: shape.cancelAtPeriodEnd,
        graceEndsAt: shape.status === "past_due" ? new Date(Date.now() + 7 * 86_400_000) : null,
      });
      return;
    }

    if ((event.type === "invoice.paid" || event.type === "invoice.payment_failed") && subscription) {
      const invoice = event.data.object;
      const customerId = idOf(invoice.customer);
      const userId = invoice.parent?.subscription_details?.metadata?.userId || subscription.metadata.userId || await accountUserId(customerId, subscription.id);
      if (!userId) return;
      const shape = subscriptionShape(subscription);
      if (event.type === "invoice.payment_failed") {
        await updateBillingAccount(tx, userId, {
          status: "past_due",
          graceEndsAt: new Date(Date.now() + 7 * 86_400_000),
        });
        return;
      }
      if (!shape.plan) return;
      await updateBillingAccount(tx, userId, {
        plan: shape.plan,
        status: "active",
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id,
        companyBlocks: shape.companyBlocks,
        currentPeriodStart: shape.periodStart,
        currentPeriodEnd: shape.periodEnd,
        cancelAtPeriodEnd: shape.cancelAtPeriodEnd,
        graceEndsAt: null,
      });
      if (shape.periodStart && shape.periodEnd) await grantMonthlyCredits(tx, userId, shape.plan, subscription.id, shape.periodStart, shape.periodEnd);
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
