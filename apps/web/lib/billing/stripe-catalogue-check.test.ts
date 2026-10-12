import { describe, expect, it, vi } from "vitest";
import { checkStripeCatalogue, expectedPrices, validatePrice } from "./stripe-catalogue-check";

const price = (overrides: Record<string, unknown> = {}) => ({
  object: "price", id: "price_search", active: true, livemode: false, currency: "gbp",
  unit_amount: 2900, billing_scheme: "per_unit", type: "recurring",
  recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  transform_quantity: null, custom_unit_amount: null, tiers_mode: null,
  tax_behavior: "inclusive", ...overrides,
});

describe("Stripe catalogue preflight", () => {
  it("derives six expected amounts and billing types from the product catalogue", () => {
    expect(expectedPrices.map(item => [item.name, item.gbp, item.recurring])).toEqual([
      ["STRIPE_PRICE_SEARCH_MONTHLY", 29, true], ["STRIPE_PRICE_INTENSIVE_MONTHLY", 49, true],
      ["STRIPE_PRICE_CV_5", 5, false], ["STRIPE_PRICE_CV_10", 9, false],
      ["STRIPE_PRICE_CV_20", 15, false], ["STRIPE_PRICE_COMPANY_BLOCK_MONTHLY", 1, true],
    ]);
  });

  it("rejects mismatched mode, amount, tax and quantity model", () => {
    const result = validatePrice("STRIPE_PRICE_SEARCH_MONTHLY", price({ livemode: true, unit_amount: 3000,
      tax_behavior: "exclusive", billing_scheme: "tiered", recurring: { interval: "year", interval_count: 1, usage_type: "metered" } }),
    expectedPrices[0]!, "test");
    expect(result.errors).toHaveLength(5);
    expect(JSON.stringify(result)).not.toContain("price_search");
  });

  it("flags unspecified tax for human confirmation", () => {
    const result = validatePrice("STRIPE_PRICE_SEARCH_MONTHLY", price({ tax_behavior: "unspecified" }), expectedPrices[0]!, "test");
    expect(result.errors).toEqual([]);
    expect(result.attention).toHaveLength(1);
  });

  it("reads only six fixed Stripe Price URLs, with GET and no redirect", async () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", STRIPE_SECRET_KEY: "sk_test_private" };
    for (const item of expectedPrices) env[item.name] = `price_${item.name}`;
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const item = expectedPrices.find(row => String(url).endsWith(`price_${row.name}`))!;
      return new Response(JSON.stringify(price({ id: `price_${item.name}`, unit_amount: item.gbp * 100,
        type: item.recurring ? "recurring" : "one_time", recurring: item.recurring ? price().recurring : null })),
      { status: 200 });
    });
    const result = await checkStripeCatalogue(env, "test", request as typeof fetch);
    expect(result.errors).toEqual([]);
    expect(request).toHaveBeenCalledTimes(6);
    for (const [url, init] of request.mock.calls as [string, RequestInit][]) {
      expect(url).toMatch(/^https:\/\/api\.stripe\.com\/v1\/prices\/price_/);
      expect(init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
    }
  });

  it("rejects missing or duplicate IDs before any request and redacts provider errors", async () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", STRIPE_SECRET_KEY: "sk_test_private" };
    for (const item of expectedPrices) env[item.name] = `price_${item.name}`;
    env.STRIPE_PRICE_CV_10 = env.STRIPE_PRICE_CV_5;
    const request = vi.fn();
    expect((await checkStripeCatalogue(env, "test", request as typeof fetch)).errors).toContain(
      "STRIPE_PRICE_CV_10 duplicates STRIPE_PRICE_CV_5");
    expect(request).not.toHaveBeenCalled();
    env.STRIPE_PRICE_CV_10 = "price_unique";
    const failed = await checkStripeCatalogue(env, "test", async () => new Response("private-response-body", { status: 401 }));
    expect(JSON.stringify(failed)).not.toContain("private-response-body");
    expect(JSON.stringify(failed)).not.toContain("sk_test_private");
  });
});
