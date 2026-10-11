/** Read-only Stripe Price preflight. The only remote endpoint is Stripe's fixed Price API. */
import { COMPANY_BLOCK_PRICE_GBP, CV_TOPUPS, PLAN_CATALOG } from "@col/db";
import { planPriceEnv, topupPriceEnv } from "./stripe";

type Mode = "test" | "live";
type PriceShape = {
  object?: unknown; id?: unknown; active?: unknown; livemode?: unknown; currency?: unknown;
  unit_amount?: unknown; billing_scheme?: unknown; type?: unknown; tax_behavior?: unknown;
  recurring?: { interval?: unknown; interval_count?: unknown; usage_type?: unknown } | null;
  transform_quantity?: unknown; custom_unit_amount?: unknown; tiers_mode?: unknown;
};
type ExpectedPrice = { name: string; gbp: number; recurring: boolean };

export const expectedPrices: readonly ExpectedPrice[] = [
  ...Object.entries(planPriceEnv).map(([plan, name]) => ({
    name, gbp: PLAN_CATALOG[plan as keyof typeof planPriceEnv].monthlyGbp, recurring: true,
  })),
  ...Object.entries(topupPriceEnv).map(([pack, name]) => ({
    name, gbp: CV_TOPUPS[pack as keyof typeof topupPriceEnv].priceGbp, recurring: false,
  })),
  { name: "STRIPE_PRICE_COMPANY_BLOCK_MONTHLY", gbp: COMPANY_BLOCK_PRICE_GBP, recurring: true },
];

/** Pure validation of a Stripe Price; errors mention only the configuration name. */
export function validatePrice(name: string, price: PriceShape, expected: ExpectedPrice, mode: Mode) {
  const errors: string[] = [];
  const attention: string[] = [];
  if (price.object !== "price") errors.push(`${name}: Stripe did not return a Price object`);
  if (price.active !== true) errors.push(`${name}: Price is inactive`);
  if (price.livemode !== (mode === "live")) errors.push(`${name}: Price mode differs from --mode=${mode}`);
  if (price.currency !== "gbp") errors.push(`${name}: currency must be GBP`);
  if (price.unit_amount !== expected.gbp * 100) errors.push(`${name}: unit amount differs from the product catalogue`);
  if (price.billing_scheme !== "per_unit" || price.transform_quantity != null ||
    price.custom_unit_amount != null || price.tiers_mode != null) {
    errors.push(`${name}: Price must be a fixed amount per unit with no quantity transform or tiers`);
  }
  if (expected.recurring) {
    if (price.type !== "recurring" || price.recurring?.interval !== "month" ||
      price.recurring?.interval_count !== 1 || price.recurring?.usage_type !== "licensed") {
      errors.push(`${name}: Price must recur monthly at a licensed quantity`);
    }
  } else if (price.type !== "one_time" || price.recurring != null) {
    errors.push(`${name}: Price must be one-off`);
  }
  if (price.tax_behavior === "exclusive") errors.push(`${name}: exclusive tax conflicts with the documented VAT-inclusive customer price`);
  else if (price.tax_behavior !== "inclusive") attention.push(`${name}: confirm Stripe Tax default and checkout total are VAT-inclusive`);
  return { errors, attention };
}

export async function checkStripeCatalogue(
  env: NodeJS.ProcessEnv,
  mode: Mode,
  fetchPrice: typeof fetch = fetch,
) {
  const errors: string[] = [];
  const attention: string[] = [];
  const key = env.STRIPE_SECRET_KEY?.trim() ?? "";
  if (!new RegExp(`^sk_${mode}_\\S+$`).test(key)) {
    return { errors: [`STRIPE_SECRET_KEY must be a Stripe ${mode} secret key`], attention };
  }
  const ids = new Map<string, string>();
  for (const expected of expectedPrices) {
    const id = env[expected.name]?.trim() ?? "";
    if (!/^price_[A-Za-z0-9_]+$/.test(id)) errors.push(`${expected.name} must be a Stripe Price id`);
    else if (ids.has(id)) errors.push(`${expected.name} duplicates ${ids.get(id)}`);
    else ids.set(id, expected.name);
  }
  if (errors.length) return { errors, attention };

  await Promise.all(expectedPrices.map(async expected => {
    const id = env[expected.name]!.trim();
    try {
      const response = await fetchPrice(`https://api.stripe.com/v1/prices/${encodeURIComponent(id)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        errors.push(`${expected.name}: Stripe Price lookup failed (HTTP ${response.status})`);
        return;
      }
      const price = await response.json() as PriceShape;
      if (price.id !== id) {
        errors.push(`${expected.name}: Stripe returned a different Price`);
        return;
      }
      const result = validatePrice(expected.name, price, expected, mode);
      errors.push(...result.errors);
      attention.push(...result.attention);
    } catch {
      errors.push(`${expected.name}: Stripe Price lookup failed or timed out`);
    }
  }));
  return { errors, attention };
}
