import { afterEach, expect, it, vi } from "vitest";
import { stripeCheckoutConfigured, stripeConfigured } from "./stripe";

afterEach(() => vi.unstubAllEnvs());

it("requires a webhook secret before offering a charge but keeps portal access", () => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_local");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
  expect(stripeConfigured()).toBe(true);
  expect(stripeCheckoutConfigured()).toBe(false);
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_local");
  expect(stripeCheckoutConfigured()).toBe(true);
});
