"use server";

import { z } from "zod";
import { CareerChangeSchema, type CareerChange, type CareerChangeResult, type CareerWorkspace } from "@col/core/career-record";
import { getCareerWorkspace as readWorkspace, saveCareerChange as writeChange,
  undoCareerChange as undoChange } from "@col/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { actionError } from "@/lib/validation";
import { revalidatePath } from "next/cache";

const ReadSchema = z.object({ recordId: z.string().uuid().optional(), legacyJobId: z.string().min(1).max(100).optional(),
  assertionId: z.string().uuid().optional(),
  query: z.string().trim().max(200).optional(), cursor: z.string().max(120).optional(),
  assertionsCursor: z.string().uuid().optional(), linksCursor: z.string().uuid().optional(),
  changesCursor: z.number().int().positive().optional() });
const UndoSchema = z.object({ changeId: z.string().uuid(), expectedRevision: z.number().int().nonnegative(),
  requestKey: z.string().trim().min(1).max(120) });

export async function getCareerWorkspace(options: { recordId?: string; legacyJobId?: string; assertionId?: string; query?: string; cursor?: string;
  assertionsCursor?: string; linksCursor?: string; changesCursor?: number } = {}): Promise<CareerWorkspace> {
  const user = await requireUser();
  const parsed = ReadSchema.parse(options);
  return readWorkspace(db(), user.id, parsed);
}

export async function saveCareerChange(input: CareerChange): Promise<CareerChangeResult> {
  const user = await requireUser();
  const parsed = CareerChangeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check this Experience change and try again." };
  try {
    const result = await writeChange(db(), user.id, parsed.data);
    revalidatePath("/library");
    revalidatePath("/cv");
    return result;
  } catch (error) {
    const result = actionError(error, "Could not save this Experience change. Your entry is still in the editor.");
    return result.ok ? { ok: false, error: "Could not save this Experience change." } : result;
  }
}

export async function undoCareerChange(input: { changeId: string; expectedRevision: number; requestKey: string }): Promise<CareerChangeResult> {
  const user = await requireUser();
  const parsed = UndoSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That Experience change could not be undone." };
  try {
    const result = await undoChange(db(), user.id, parsed.data);
    revalidatePath("/library");
    revalidatePath("/cv");
    return result;
  } catch (error) {
    const result = actionError(error, "Could not undo that Experience change. Reload it and try again.");
    return result.ok ? { ok: false, error: "Could not undo that Experience change." } : result;
  }
}
