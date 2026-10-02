"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { CV_TOPUPS, type CvTopupKey } from "@ava/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getBillingSummary } from "@/lib/billing/service";
import { planPriceId, stripeClient, stripeConfigured, topupPriceId } from "@/lib/billing/stripe";
import { emailLinkOrigin } from "@/lib/origin";

const safeReturn = (value: FormDataEntryValue | null): string => {
  const path = typeof value === "string" ? value : "";
  return path.startsWith("/") && !path.startsWith("//") ? path : "/account#plan-and-credits";
};

async function checkoutOrigin(): Promise<string> {
  return (await emailLinkOrigin()) ?? "http://localhost:3000";
}

export async function startPlanCheckout(form: FormData): Promise<void> {
  const user = await requireUser();
  const plan = String(form.get("plan") ?? "");
  if (plan !== "search" && plan !== "intensive") redirect("/account?billing=unknown_plan#plan-and-credits");
  if (!stripeConfigured()) redirect("/account?billing=setup_required#plan-and-credits");
  const price = planPriceId(plan);
  if (!price) redirect("/account?billing=setup_required#plan-and-credits");
  const summary = await getBillingSummary(user.id);
  const origin = await checkoutOrigin();
  const returnTo = safeReturn(form.get("returnTo"));
  const session = await stripeClient().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    ...(summary.stripeCustomerId ? { customer: summary.stripeCustomerId } : { customer_email: user.email }),
    client_reference_id: user.id,
    metadata: { userId: user.id, purchase: "plan", plan, returnTo },
    subscription_data: { metadata: { userId: user.id, plan } },
    allow_promotion_codes: true,
    success_url: `${origin}/account?billing=plan_started&session_id={CHECKOUT_SESSION_ID}#plan-and-credits`,
    cancel_url: `${origin}${returnTo.includes("?") ? `${returnTo}&` : `${returnTo}?`}billing=cancelled`,
  }, { idempotencyKey: `plan:${user.id}:${plan}:${randomUUID()}` });
  if (!session.url) redirect("/account?billing=checkout_failed#plan-and-credits");
  redirect(session.url);
}

export async function startCreditCheckout(form: FormData): Promise<void> {
  const user = await requireUser();
  const pack = String(form.get("pack") ?? "") as CvTopupKey;
  if (!(pack in CV_TOPUPS)) redirect("/account?billing=unknown_pack#plan-and-credits");
  if (!stripeConfigured()) redirect("/account?billing=setup_required#plan-and-credits");
  const price = topupPriceId(pack);
  if (!price) redirect("/account?billing=setup_required#plan-and-credits");
  const summary = await getBillingSummary(user.id);
  const origin = await checkoutOrigin();
  const returnTo = safeReturn(form.get("returnTo"));
  const session = await stripeClient().checkout.sessions.create({
    mode: "payment",
    line_items: [{ price, quantity: 1 }],
    ...(summary.stripeCustomerId ? { customer: summary.stripeCustomerId } : { customer_email: user.email, customer_creation: "always" }),
    client_reference_id: user.id,
    metadata: { userId: user.id, purchase: "cv_topup", pack, returnTo },
    success_url: `${origin}/account?billing=credits_added&session_id={CHECKOUT_SESSION_ID}#plan-and-credits`,
    cancel_url: `${origin}${returnTo.includes("?") ? `${returnTo}&` : `${returnTo}?`}billing=cancelled`,
  }, { idempotencyKey: `topup:${user.id}:${pack}:${randomUUID()}` });
  if (!session.url) redirect("/account?billing=checkout_failed#plan-and-credits");
  redirect(session.url);
}

export async function openBillingPortal(): Promise<void> {
  const user = await requireUser();
  if (!stripeConfigured()) redirect("/account?billing=setup_required#plan-and-credits");
  const summary = await getBillingSummary(user.id);
  if (!summary.stripeCustomerId) redirect("/account?billing=no_customer#plan-and-credits");
  const origin = await checkoutOrigin();
  const session = await stripeClient().billingPortal.sessions.create({
    customer: summary.stripeCustomerId,
    return_url: `${origin}/account#plan-and-credits`,
  });
  redirect(session.url);
}
