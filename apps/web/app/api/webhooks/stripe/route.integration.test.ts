import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { getBillingSummary, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";

let database: Db;
let pool: ReturnType<typeof createTestDb>["pool"];
vi.mock("@/lib/db", () => ({ db: () => database }));

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.STRIPE_SECRET_KEY = "sk_test_ava_local";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_ava_test";
});
afterAll(async () => {
  await pool.end();
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
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

it("rejects an invalid webhook signature before touching billing state", async () => {
  const { POST } = await import("./route");
  const response = await POST(await signedRequest("{}", "bad-signature"));
  expect(response.status).toBe(400);
});
