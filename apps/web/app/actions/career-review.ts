"use server";

import { z } from "zod";
import { CareerConflictDecisionInputSchema, type CareerConflictDecisionInput,
  type CareerConflictDecisionResult } from "@col/core/career-record";
import { getCareerReviewSummary as readSummary, listCareerReviewIssues as readIssues,
  getCareerConflictDetail as readDetail, decideCareerConflict as writeDecision } from "@col/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { actionError } from "@/lib/validation";
import { revalidatePath } from "next/cache";

const id = z.string().regex(/^[0-9a-f]{64}$/);
const listOptions = z.object({ status: z.enum(["active", "deferred", "decided"]).optional(),
  cursor: id.optional() });

export async function getCareerReviewSummary() {
  const user = await requireUser();
  return readSummary(db(), user.id);
}

export async function listCareerReviewIssues(options: { status?: "active" | "deferred" | "decided";
  cursor?: string } = {}) {
  const user = await requireUser();
  return readIssues(db(), user.id, listOptions.parse(options));
}

export async function getCareerConflictDetail(conflictId: string, historyCursor?: number) {
  const user = await requireUser();
  return readDetail(db(), user.id, id.parse(conflictId), historyCursor === undefined ? undefined
    : z.number().int().positive().parse(historyCursor));
}

export async function decideCareerConflict(input: CareerConflictDecisionInput): Promise<CareerConflictDecisionResult> {
  const user = await requireUser();
  const parsed = CareerConflictDecisionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the issue and decision before saving." };
  try {
    const result = await writeDecision(db(), user.id, parsed.data);
    revalidatePath("/library");
    revalidatePath("/cv");
    revalidatePath("/account");
    return result;
  } catch (error) {
    const result = actionError(error, "Could not save the review decision. Your wording is still in the editor.");
    return result.ok ? { ok: false, error: "Could not save the review decision." } : result;
  }
}
