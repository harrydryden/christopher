import {
  assertCanActivateCompanies as assertCompanyCapacity,
  getBillingSummary as readBillingSummary,
  getCompanyEntitlement as readCompanyEntitlement,
  type BillingSummary,
  type BillingWriter,
} from "@ava/db";
import { db } from "@/lib/db";

export type { BillingSummary } from "@ava/db";

export function getBillingSummary(userId: string): Promise<BillingSummary> {
  return readBillingSummary(db(), userId);
}

export function getCompanyEntitlement(userId: string, writer: BillingWriter = db()) {
  return readCompanyEntitlement(writer, userId);
}

export function assertCanActivateCompanies(userId: string, increment = 1, writer: BillingWriter = db()) {
  return assertCompanyCapacity(writer, userId, increment);
}
