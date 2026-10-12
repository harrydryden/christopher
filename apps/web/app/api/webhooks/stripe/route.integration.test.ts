import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { ensureFreeEntitlement, getBillingSummary, grantCvCredits, schema, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";

let database: Db;
let pool: ReturnType<typeof createTestDb>["pool"];
vi.mock("@/lib/db", () => ({ db: () => database }));

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.STRIPE_SECRET_KEY = "sk_test_col_local";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_col_test";
  process.env.STRIPE_PRICE_SEARCH_MONTHLY = "price_search_test";
  process.env.STRIPE_PRICE_INTENSIVE_MONTHLY = "price_intensive_test";
  process.env.STRIPE_PRICE_COMPANY_BLOCK_MONTHLY = "price_company_block_test";
});
afterAll(async () => {
  await pool.end();
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_PRICE_SEARCH_MONTHLY;
  delete process.env.STRIPE_PRICE_INTENSIVE_MONTHLY;
  delete process.env.STRIPE_PRICE_COMPANY_BLOCK_MONTHLY;
});

async function signedRequest(payload: string, signature = "") {
  const { stripeClient } = await import("@/lib/billing/stripe");
  const header = signature || stripeClient().webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET!,
  });
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    body: payload,
    headers: { "stripe-signature": header, "content-type": "application/json" },
  });
}

const subscription = (userId: string, status: "active" | "canceled" = "active") => ({
  id: `sub_${userId.replaceAll("-", "")}`,
  object: "subscription",
  customer: `cus_${userId.replaceAll("-", "")}`,
  status,
  metadata: { userId, plan: "search" },
  cancel_at_period_end: false,
  items: { data: [{
    id: `si_${userId.replaceAll("-", "")}`,
    price: { id: "price_search_test" },
    quantity: 1,
    current_period_start: 1_799_900_000,
    current_period_end: 1_802_500_000,
  }] },
});

const eventPayload = (id: string, type: string, created: number, object: unknown) => JSON.stringify({
  id,
  object: "event",
  api_version: "2025-10-29.clover",
  created,
  data: { object },
  livemode: false,
  pending_webhooks: 1,
  request: { id: null, idempotency_key: null },
  type,
});

it("fulfils a paid CV top-up once when Stripe retries the event", async () => {
  const id = randomUUID();
  await database.insert(schema.users).values({ id, email: `stripe-${id}@example.com`, claimedAt: new Date() });
  try {
    const payload = JSON.stringify({
      id: `evt_${id.replaceAll("-", "")}`,
      object: "event",
      api_version: "2025-10-29.clover",
      created: Math.floor(Date.now() / 1000),
      data: { object: {
        id: `cs_${id.replaceAll("-", "")}`,
        object: "checkout.session",
        client_reference_id: id,
        customer: "cus_test",
        amount_total: 500,
        currency: "gbp",
        metadata: { userId: id, purchase: "cv_topup", pack: "cv5", returnTo: "/account" },
        mode: "payment",
        payment_status: "paid",
        status: "complete",
        subscription: null,
      } },
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: "checkout.session.completed",
    });
    const { POST } = await import("./route");
    expect((await POST(await signedRequest(payload))).status).toBe(200);
    expect((await POST(await signedRequest(payload))).status).toBe(200);
    expect((await getBillingSummary(database, id)).cv).toMatchObject({ available: 8, welcome: 3, purchased: 5 });
  } finally {
    await database.delete(schema.users).where(eq(schema.users.id, id));
  }
});

it("grants monthly credits only after payment and ignores an older cancellation delivery", async () => {
  const id = randomUUID();
  await database.insert(schema.users).values({ id, email: `stripe-order-${id}@example.com`, claimedAt: new Date() });
  const { stripeClient } = await import("@/lib/billing/stripe");
  const currentSubscription = vi.spyOn(stripeClient().subscriptions, "retrieve").mockResolvedValue(subscription(id) as never);
  try {
    const { POST } = await import("./route");
    const sub = subscription(id);
    const incompleteCheckout = eventPayload(`evt_checkout_${id}`, "checkout.session.completed", 200, {
      id: `cs_plan_${id}`, object: "checkout.session", client_reference_id: id, customer: sub.customer,
      metadata: { userId: id, purchase: "plan", plan: "search" }, mode: "subscription",
      payment_status: "unpaid", status: "complete", subscription: sub,
    });
    expect((await POST(await signedRequest(incompleteCheckout))).status).toBe(200);
    expect((await getBillingSummary(database, id)).cv.monthly).toBe(0);

    const paid = eventPayload(`evt_invoice_${id}`, "invoice.paid", 300, {
      id: `in_${id}`, object: "invoice", customer: sub.customer,
      lines: { data: [{ pricing: { price_details: { price: "price_search_test" } }, period: { start: 1_799_900_000, end: 1_802_500_000 } }] },
      parent: { type: "subscription_details", quote_details: null, subscription_details: { subscription: sub, metadata: { userId: id } } },
    });
    expect((await POST(await signedRequest(paid))).status).toBe(200);
    expect(await getBillingSummary(database, id)).toMatchObject({ plan: "search", status: "active", cv: { monthly: 10 } });

    const staleCancellation = eventPayload(`evt_stale_${id}`, "customer.subscription.deleted", 250, subscription(id, "canceled"));
    expect((await POST(await signedRequest(staleCancellation))).status).toBe(200);
    expect(await getBillingSummary(database, id)).toMatchObject({ plan: "search", status: "active" });
  } finally {
    currentSubscription.mockRestore();
    await database.delete(schema.users).where(eq(schema.users.id, id));
  }
});

it("grants a late paid invoice without reviving a subsequently cancelled subscription", async () => {
  const id = randomUUID();
  await database.insert(schema.users).values({ id, email: `stripe-late-${id}@example.com`, claimedAt: new Date() });
  const { stripeClient } = await import("@/lib/billing/stripe");
  const currentSubscription = vi.spyOn(stripeClient().subscriptions, "retrieve").mockResolvedValue(subscription(id, "canceled") as never);
  try {
    const { POST } = await import("./route");
    const sub = subscription(id);
    const current = eventPayload(`evt_current_${id}`, "customer.subscription.deleted", 800, subscription(id, "canceled"));
    expect((await POST(await signedRequest(current))).status).toBe(200);
    const paid = eventPayload(`evt_late_paid_${id}`, "invoice.paid", 700, {
      id: `in_late_${id}`, object: "invoice", customer: sub.customer,
      lines: { data: [{ pricing: { price_details: { price: "price_search_test" } }, period: { start: 1_797_300_000, end: 1_799_900_000 } }] },
      parent: { subscription_details: { subscription: sub, metadata: { userId: id } } },
    });
    expect((await POST(await signedRequest(paid))).status).toBe(200);
    const grants = await database.select().from(schema.creditGrants).where(eq(schema.creditGrants.userId, id));
    const monthly = grants.filter(grant => grant.source === "monthly");
    expect(monthly).toHaveLength(1);
    expect(monthly[0]?.externalRef).toBe(`${sub.id}:${new Date(1_797_300_000_000).toISOString()}`);
    expect(await getBillingSummary(database, id)).toMatchObject({ plan: "free", status: "cancelled" });
  } finally {
    currentSubscription.mockRestore();
    await database.delete(schema.users).where(eq(schema.users.id, id));
  }
});

it("does not grant monthly credits for an add-on or proration-only paid invoice", async () => {
  const id = randomUUID();
  await database.insert(schema.users).values({ id, email: `stripe-addon-${id}@example.com`, claimedAt: new Date() });
  const sub = subscription(id);
  try {
    const { POST } = await import("./route");
    const paid = eventPayload(`evt_addon_${id}`, "invoice.paid", 700, {
      id: `in_addon_${id}`, object: "invoice", customer: sub.customer,
      lines: { data: [
        { pricing: { price_details: { price: "price_company_block_test" } }, period: { start: 1_799_900_000, end: 1_802_500_000 } },
        { pricing: { price_details: { price: "price_search_test" } }, proration: true, period: { start: 1_799_900_000, end: 1_802_500_000 } },
      ] },
      parent: { subscription_details: { subscription: sub, metadata: { userId: id } } },
    });
    expect((await POST(await signedRequest(paid))).status).toBe(200);
    expect((await getBillingSummary(database, id)).cv.monthly).toBe(0);
  } finally {
    await database.delete(schema.users).where(eq(schema.users.id, id));
  }
});

it("finds the paid plan line beyond the invoice webhook's embedded page", async () => {
  const id = randomUUID();
  await database.insert(schema.users).values({ id, email: `stripe-lines-${id}@example.com`, claimedAt: new Date() });
  const sub = subscription(id);
  const { stripeClient } = await import("@/lib/billing/stripe");
  const list = vi.spyOn(stripeClient().invoices, "listLineItems").mockReturnValue((async function* () {
    yield { pricing: { price_details: { price: "price_search_test" } }, period: { start: 1_799_900_000, end: 1_802_500_000 } };
  })() as never);
  try {
    const { POST } = await import("./route");
    const paid = eventPayload(`evt_lines_${id}`, "invoice.paid", 700, {
      id: `in_lines_${id}`, object: "invoice", customer: sub.customer,
      lines: { has_more: true, data: [{ pricing: { price_details: { price: "price_company_block_test" } } }] },
      parent: { subscription_details: { subscription: sub, metadata: { userId: id } } },
    });
    expect((await POST(await signedRequest(paid))).status).toBe(200);
    expect(list).toHaveBeenCalledWith(`in_lines_${id}`, { limit: 100 });
    expect((await getBillingSummary(database, id)).cv.monthly).toBe(10);
  } finally {
    list.mockRestore();
    await database.delete(schema.users).where(eq(schema.users.id, id));
  }
});

it("keeps a fully refunded top-up void when its checkout event arrives later", async () => {
  const id = randomUUID();
  await database.insert(schema.users).values({ id, email: `stripe-early-refund-${id}@example.com`, claimedAt: new Date() });
  await ensureFreeEntitlement(database, id);
  const checkoutId = `cs_refunded_first_${id}`;
  const { stripeClient } = await import("@/lib/billing/stripe");
  const sessions = vi.spyOn(stripeClient().checkout.sessions, "list").mockResolvedValue({ data: [{ id: checkoutId }] } as never);
  try {
    const { POST } = await import("./route");
    const refund = eventPayload(`evt_early_refund_${id}`, "charge.refunded", 900, {
      id: `ch_${id}`, object: "charge", amount: 500, amount_refunded: 500, payment_intent: `pi_${id}`,
    });
    expect((await POST(await signedRequest(refund))).status).toBe(200);
    const checkout = eventPayload(`evt_late_checkout_${id}`, "checkout.session.completed", 700, {
      id: checkoutId, object: "checkout.session", client_reference_id: id, customer: `cus_${id}`,
      amount_total: 500, currency: "gbp", metadata: { userId: id, purchase: "cv_topup", pack: "cv5" },
      mode: "payment", payment_status: "paid", status: "complete", subscription: null,
    });
    expect((await POST(await signedRequest(checkout))).status).toBe(200);
    expect((await getBillingSummary(database, id)).cv).toMatchObject({ available: 3, purchased: 0 });
  } finally {
    sessions.mockRestore();
    await database.delete(schema.users).where(eq(schema.users.id, id));
  }
});

it("serialises a checkout and refund delivered at the same time", async () => {
  const id = randomUUID();
  await database.insert(schema.users).values({ id, email: `stripe-racing-refund-${id}@example.com`, claimedAt: new Date() });
  await ensureFreeEntitlement(database, id);
  const checkoutId = `cs_racing_${id}`;
  const { stripeClient } = await import("@/lib/billing/stripe");
  const sessions = vi.spyOn(stripeClient().checkout.sessions, "list").mockResolvedValue({ data: [{ id: checkoutId }] } as never);
  try {
    const { POST } = await import("./route");
    const refund = eventPayload(`evt_racing_refund_${id}`, "charge.refunded", 900, {
      id: `ch_${id}`, object: "charge", amount: 500, amount_refunded: 500, payment_intent: `pi_${id}`,
    });
    const checkout = eventPayload(`evt_racing_checkout_${id}`, "checkout.session.completed", 700, {
      id: checkoutId, object: "checkout.session", client_reference_id: id, customer: `cus_${id}`,
      amount_total: 500, currency: "gbp", metadata: { userId: id, purchase: "cv_topup", pack: "cv5" },
      mode: "payment", payment_status: "paid", status: "complete", subscription: null,
    });
    const responses = await Promise.all([POST(await signedRequest(refund)), POST(await signedRequest(checkout))]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect((await getBillingSummary(database, id)).cv).toMatchObject({ available: 3, purchased: 0 });
  } finally {
    sessions.mockRestore();
    await database.delete(schema.users).where(eq(schema.users.id, id));
  }
});

it("refuses a top-up whose paid amount does not match its configured pack", async () => {
  const id = randomUUID();
  await database.insert(schema.users).values({ id, email: `stripe-price-${id}@example.com`, claimedAt: new Date() });
  await ensureFreeEntitlement(database, id);
  try {
    const payload = eventPayload(`evt_bad_price_${id}`, "checkout.session.completed", 400, {
      id: `cs_bad_${id}`, object: "checkout.session", client_reference_id: id, customer: `cus_${id}`,
      amount_total: 100, currency: "gbp", metadata: { userId: id, purchase: "cv_topup", pack: "cv5" },
      mode: "payment", payment_status: "paid", status: "complete", subscription: null,
    });
    const { POST } = await import("./route");
    expect((await POST(await signedRequest(payload))).status).toBe(200);
    expect((await getBillingSummary(database, id)).cv).toMatchObject({ available: 3, purchased: 0 });
  } finally {
    await database.delete(schema.users).where(eq(schema.users.id, id));
  }
});

it("rejects an invalid webhook signature before touching billing state", async () => {
  const { POST } = await import("./route");
  const response = await POST(await signedRequest("{}", "bad-signature"));
  expect(response.status).toBe(400);
});

it("revokes the unused part of a fully refunded top-up", async () => {
  const id = randomUUID();
  await database.insert(schema.users).values({ id, email: `stripe-refund-${id}@example.com`, claimedAt: new Date() });
  await ensureFreeEntitlement(database, id);
  await grantCvCredits(database, { userId: id, source: "topup", units: 5, externalRef: `cs_refund_${id}` });
  const { stripeClient } = await import("@/lib/billing/stripe");
  const sessions = vi.spyOn(stripeClient().checkout.sessions, "list").mockResolvedValue({ data: [{ id: `cs_refund_${id}` }] } as never);
  try {
    const payload = eventPayload(`evt_refund_${id}`, "charge.refunded", 500, {
      id: `ch_${id}`, object: "charge", amount: 500, amount_refunded: 500, payment_intent: `pi_${id}`,
    });
    const { POST } = await import("./route");
    expect((await POST(await signedRequest(payload))).status).toBe(200);
    expect((await getBillingSummary(database, id)).cv).toMatchObject({ available: 3, purchased: 0 });
  } finally {
    sessions.mockRestore();
    await database.delete(schema.users).where(eq(schema.users.id, id));
  }
});

it("removes Search-only company blocks when a Portal change moves the subscription to Intensive", async () => {
  const id = randomUUID();
  await database.insert(schema.users).values({ id, email: `stripe-plan-${id}@example.com`, claimedAt: new Date() });
  await ensureFreeEntitlement(database, id);
  const base = subscription(id);
  const intensive = {
    ...base,
    metadata: { userId: id, plan: "intensive" },
    items: { data: [
      { ...base.items.data[0], price: { id: "price_intensive_test" } },
      { id: `si_block_${id}`, price: { id: "price_company_block_test" }, quantity: 3 },
    ] },
  };
  const normalised = { ...intensive, items: { data: [intensive.items.data[0]] } };
  const { stripeClient } = await import("@/lib/billing/stripe");
  const retrieve = vi.spyOn(stripeClient().subscriptions, "retrieve")
    .mockResolvedValueOnce(intensive as never)
    .mockResolvedValueOnce(normalised as never);
  const remove = vi.spyOn(stripeClient().subscriptionItems, "del").mockResolvedValue({} as never);
  try {
    const payload = eventPayload(`evt_plan_${id}`, "customer.subscription.updated", 600, intensive);
    const { POST } = await import("./route");
    expect((await POST(await signedRequest(payload))).status).toBe(200);
    expect(remove).toHaveBeenCalledWith(`si_block_${id}`, { proration_behavior: "always_invoice" });
    expect(await getBillingSummary(database, id)).toMatchObject({ plan: "intensive", status: "active", companies: { paidBlocks: 0, capacity: 200 } });
  } finally {
    retrieve.mockRestore();
    remove.mockRestore();
    await database.delete(schema.users).where(eq(schema.users.id, id));
  }
});
