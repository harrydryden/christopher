import { createHmac, timingSafeEqual } from "node:crypto";
import { COMPANY_BLOCK_SIZE, PLAN_CATALOG, updateBillingAccount } from "@ava/db";
import { billingAccounts } from "@ava/db/schema";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { getBillingSummary } from "./service";
import { companyBlockPriceId, stripeClient, stripeConfigured } from "./stripe";

const QUOTE_TTL_SECONDS = 10 * 60;

interface CapacityQuotePayload {
  userId: string;
  subscriptionId: string;
  currentBlocks: number;
  nextBlocks: number;
  prorationDate: number;
  expiresAt: number;
}

export interface CompanyCapacityQuote {
  dueTodayPence: number;
  currency: string;
  nextMonthlyGbp: number;
  newCapacity: number;
  token: string;
}

function signingKey(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return `ava:company-capacity:${secret}`;
}

function sign(value: string): string {
  return createHmac("sha256", signingKey()).update(value).digest("base64url");
}

export function capacityQuoteToken(payload: CapacityQuotePayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

export function verifyCapacityQuoteToken(token: string, userId: string, nowSeconds = Math.floor(Date.now() / 1000)): CapacityQuotePayload | null {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;
  const expected = Buffer.from(sign(encoded));
  const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as CapacityQuotePayload;
    if (payload.userId !== userId || payload.expiresAt < nowSeconds || payload.prorationDate > nowSeconds + 30) return null;
    if (payload.nextBlocks !== payload.currentBlocks + 1 || payload.currentBlocks < 0 || payload.nextBlocks > 5) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function getCompanyCapacityQuote(userId: string): Promise<CompanyCapacityQuote | null> {
  if (!stripeConfigured()) return null;
  const summary = await getBillingSummary(userId);
  if (summary.plan !== "search" || summary.status !== "active" || !summary.stripeCustomerId || summary.companies.paidBlocks >= 5) return null;
  const [account] = await db().select({ subscriptionId: billingAccounts.stripeSubscriptionId })
    .from(billingAccounts).where(eq(billingAccounts.userId, userId)).limit(1);
  const subscriptionId = account?.subscriptionId;
  const blockPrice = companyBlockPriceId();
  if (!subscriptionId || !blockPrice) return null;
  const stripe = stripeClient();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const item = subscription.items.data.find(candidate => candidate.price.id === blockPrice);
  const currentBlocks = item?.quantity ?? 0;
  if (currentBlocks !== summary.companies.paidBlocks || currentBlocks >= 5) return null;
  const prorationDate = Math.floor(Date.now() / 1000);
  const preview = await stripe.invoices.createPreview({
    customer: summary.stripeCustomerId,
    subscription: subscriptionId,
    subscription_details: {
      items: item ? [{ id: item.id, quantity: currentBlocks + 1 }] : [{ price: blockPrice, quantity: 1 }],
      proration_behavior: "always_invoice",
      proration_date: prorationDate,
    },
  });
  const dueTodayPence = Math.max(0, preview.lines.data.reduce((total, line) =>
    line.parent?.subscription_item_details?.proration ? total + line.amount : total, 0));
  const payload: CapacityQuotePayload = {
    userId,
    subscriptionId,
    currentBlocks,
    nextBlocks: currentBlocks + 1,
    prorationDate,
    expiresAt: prorationDate + QUOTE_TTL_SECONDS,
  };
  return {
    dueTodayPence,
    currency: preview.currency,
    nextMonthlyGbp: PLAN_CATALOG.search.monthlyGbp + currentBlocks + 1,
    newCapacity: PLAN_CATALOG.search.includedCompanies + (currentBlocks + 1) * COMPANY_BLOCK_SIZE,
    token: capacityQuoteToken(payload),
  };
}

export async function applyCompanyCapacityQuote(userId: string, token: string): Promise<"ok" | "expired" | "changed"> {
  const payload = verifyCapacityQuoteToken(token, userId);
  if (!payload) return "expired";
  const blockPrice = companyBlockPriceId();
  if (!blockPrice || !stripeConfigured()) return "changed";
  const stripe = stripeClient();
  const subscription = await stripe.subscriptions.retrieve(payload.subscriptionId);
  const item = subscription.items.data.find(candidate => candidate.price.id === blockPrice);
  if ((item?.quantity ?? 0) !== payload.currentBlocks || subscription.metadata.userId !== userId) return "changed";
  if (item) await stripe.subscriptionItems.update(item.id, {
    quantity: payload.nextBlocks,
    payment_behavior: "error_if_incomplete",
    proration_behavior: "always_invoice",
    proration_date: payload.prorationDate,
  });
  else await stripe.subscriptionItems.create({
    subscription: subscription.id,
    price: blockPrice,
    quantity: 1,
    payment_behavior: "error_if_incomplete",
    proration_behavior: "always_invoice",
    proration_date: payload.prorationDate,
  });
  // The signed webhook remains authoritative; this removes the brief post-confirmation dead zone.
  await updateBillingAccount(db(), userId, { companyBlocks: payload.nextBlocks });
  return "ok";
}
