import { cache } from "react";
import {
  assertCanActivateCompanies as assertCompanyCapacity,
  getBillingSummary as readBillingSummary,
  getCompanyEntitlement as readCompanyEntitlement,
  type BillingSummary,
  type BillingWriter,
} from "@col/db";
import { db } from "@/lib/db";

export type { BillingSummary } from "@col/db";

// Share one read across the layout and page during a server render, never across requests.
export const getBillingSummary = cache((userId: string): Promise<BillingSummary> =>
  readBillingSummary(db(), userId));

export async function getCompanyEntitlement(userId: string, writer?: BillingWriter) {
  if (writer) return readCompanyEntitlement(writer, userId);
  const summary = await getBillingSummary(userId);
  return { plan: summary.plan, status: summary.status, ...summary.companies };
}

export function assertCanActivateCompanies(userId: string, increment = 1, writer: BillingWriter = db()) {
  return assertCompanyCapacity(writer, userId, increment);
}
