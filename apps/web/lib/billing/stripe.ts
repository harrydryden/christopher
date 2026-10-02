import Stripe from "stripe";
import { CV_TOPUPS, PLAN_CATALOG, type BillingPlan, type CvTopupKey } from "@ava/db";

let client: Stripe | null = null;

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
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

/** Fails deployment configuration loudly before a customer reaches Checkout. */
export function assertStripeCatalogue(): void {
  const missing = [
    ...Object.entries(planPriceEnv).filter(([plan]) => PLAN_CATALOG[plan as Exclude<BillingPlan, "free">].monthlyGbp > 0)
      .filter(([, env]) => !process.env[env]?.trim()).map(([, env]) => env),
    ...Object.entries(topupPriceEnv).filter(([, env]) => !process.env[env]?.trim()).map(([, env]) => env),
  ];
  if (missing.length) throw new Error(`Stripe price configuration is incomplete: ${missing.join(", ")}`);
}

export function topupDescription(pack: CvTopupKey): string {
  const item = CV_TOPUPS[pack];
  return `${item.credits} CV credits for £${item.priceGbp}`;
}
