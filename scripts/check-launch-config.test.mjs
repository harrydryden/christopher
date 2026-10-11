import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchConfigFindings } from "./check-launch-config.mjs";

const ready = {
  DATABASE_URL: "postgres://user:secret@db.internal:5432/app",
  SESSION_SECRET: "a".repeat(40), APP_URL: "https://app.example.co.uk",
  ANTHROPIC_API_KEY: "provider-secret", SCRAPER_CONTACT_EMAIL: "operator@example.co.uk",
  STRIPE_SECRET_KEY: "sk_live_secret", STRIPE_WEBHOOK_SECRET: "whsec_secret",
  STRIPE_PRICE_SEARCH_MONTHLY: "price_search", STRIPE_PRICE_INTENSIVE_MONTHLY: "price_intensive",
  STRIPE_PRICE_CV_5: "price_cv5", STRIPE_PRICE_CV_10: "price_cv10",
  STRIPE_PRICE_CV_20: "price_cv20", STRIPE_PRICE_COMPANY_BLOCK_MONTHLY: "price_blocks",
  ADMIN_EMAILS: "owner@example.co.uk", RESEND_API_KEY: "email-secret", EMAIL_FROM: "Course of Life <hello@example.co.uk>",
  DAILY_AI_BUDGET_USD: "10", DISCOVERY_AI_BUDGET_USD: "3",
};

test("complete offline configuration has no missing or malformed settings", () => {
  assert.deepEqual(launchConfigFindings(ready, { surface: "web" }).errors, []);
  assert.deepEqual(launchConfigFindings(ready, { surface: "worker" }).errors, []);
});

test("unset spend caps receive attention and malformed caps fail", () => {
  const missing = launchConfigFindings({ ...ready, DAILY_AI_BUDGET_USD: "", DISCOVERY_AI_BUDGET_USD: "" }, { surface: "worker" });
  assert.equal(missing.errors.length, 0);
  assert.ok(missing.attention.some(item => item.includes("DAILY_AI_BUDGET_USD")));
  const invalid = launchConfigFindings({ ...ready, DAILY_AI_BUDGET_USD: "NaN", DISCOVERY_AI_BUDGET_USD: "-1" }, { surface: "worker" });
  assert.equal(invalid.errors.length, 2);
  assert.ok(launchConfigFindings({ ...ready, DAILY_AI_BUDGET_USD: "1000000" }, { surface: "worker" })
    .attention.some(item => item.includes("effectively unlimited")));
});

test("reports absent and duplicate Stripe prices by setting name without leaking values", () => {
  const env = { ...ready, STRIPE_PRICE_CV_5: "secret-should-not-appear", STRIPE_PRICE_CV_10: "price_search" };
  const result = launchConfigFindings(env);
  assert.ok(result.errors.some(item => item.includes("STRIPE_PRICE_CV_5")));
  assert.ok(result.errors.some(item => item.includes("STRIPE_PRICE_CV_10 duplicates STRIPE_PRICE_SEARCH_MONTHLY")));
  assert.ok(!JSON.stringify(result).includes("secret-should-not-appear"));
});

test("rejects example session secret, local origin and example contact", () => {
  const result = launchConfigFindings({ ...ready, SESSION_SECRET: "change-me-to-a-long-random-string", APP_URL: "http://localhost:3000", SCRAPER_CONTACT_EMAIL: "you@example.com" });
  assert.ok(result.errors.some(item => item.includes("SESSION_SECRET")));
  assert.ok(result.errors.some(item => item.includes("APP_URL")));
  assert.ok(launchConfigFindings({ ...ready, SCRAPER_CONTACT_EMAIL: "you@example.com" }, { surface: "worker" })
    .errors.some(item => item.includes("SCRAPER_CONTACT_EMAIL")));
});

test("live web check rejects test Stripe key and token logging, and requires email delivery", () => {
  const result = launchConfigFindings({ ...ready, STRIPE_SECRET_KEY: "sk_test_secret", AUTH_EMAIL_LOG: "1", RESEND_API_KEY: "" });
  assert.ok(result.errors.some(item => item.includes("Stripe live")));
  assert.ok(result.errors.some(item => item.includes("AUTH_EMAIL_LOG")));
  assert.ok(result.errors.some(item => item.includes("RESEND_API_KEY")));
  assert.deepEqual(launchConfigFindings({ ...ready, STRIPE_SECRET_KEY: "sk_test_secret" }, { mode: "test" }).errors, []);
});

test("web and worker checks require only their own settings", () => {
  const web = launchConfigFindings({ ...ready, ANTHROPIC_API_KEY: "", SCRAPER_CONTACT_EMAIL: "" });
  const worker = launchConfigFindings({ ...ready, SESSION_SECRET: "", STRIPE_SECRET_KEY: "" }, { surface: "worker" });
  assert.deepEqual(web.errors, []);
  assert.deepEqual(worker.errors, []);
});

test("CLI rejects missing or unknown options", () => {
  for (const args of [[], ["--surface=web"], ["--surface=web", "--mode=live", "--unknown"]]) {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("./check-launch-config.mjs", import.meta.url)), ...args], { encoding: "utf8" });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /Usage:/);
  }
});
