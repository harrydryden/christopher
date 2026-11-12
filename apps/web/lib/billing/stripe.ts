import Stripe from "stripe";
import { type BillingPlan, type CvTopupKey } from "@col/db";

let client: Stripe | null = null;

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

/** Require a webhook signing secret before offering a new charge. */
export function stripeCheckoutConfigured(): boolean {
  return stripeConfigured() && Boolean(process.env.STRIPE_WEBHOOK_SECRET?.trim());
}

export function stripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  if (!client) client = new Stripe(key, { typescript: true });
  return client;
}

export const planPriceEnv = {
  search: "STRIPE_PRICE_SEARCH_MONTHLY",
  intensive: "STRIPE_PRICE_INTENSIVE_MONTHLY",
} as const;

export const topupPriceEnv = {
  cv5: "STRIPE_PRICE_CV_5",
  cv10: "STRIPE_PRICE_CV_10",
  cv20: "STRIPE_PRICE_CV_20",
} as const;

export function planPriceId(plan: Exclude<BillingPlan, "free">): string | null {
  return process.env[planPriceEnv[plan]]?.trim() || null;
}

export function topupPriceId(pack: CvTopupKey): string | null {
  return process.env[topupPriceEnv[pack]]?.trim() || null;
}

export function companyBlockPriceId(): string | null {
  return process.env.STRIPE_PRICE_COMPANY_BLOCK_MONTHLY?.trim() || null;
}

export function planForPrice(priceId: string | null | undefined): Exclude<BillingPlan, "free"> | null {
  if (!priceId) return null;
  return (Object.keys(planPriceEnv) as Array<Exclude<BillingPlan, "free">>)
    .find(plan => planPriceId(plan) === priceId) ?? null;
}

export function packForPrice(priceId: string | null | undefined): CvTopupKey | null {
  if (!priceId) return null;
  return (Object.keys(topupPriceEnv) as CvTopupKey[]).find(pack => topupPriceId(pack) === priceId) ?? null;
}
