"use server";

import { z } from "zod";
import { confirmCvTargetingPrioritiesForUser, CvTargetingConfirmationError, reserveCvCredit } from "@col/db";
import { assertCvBuildCapacity } from "@/lib/cv-build-capacity";
import { CvTargetingBriefSchema, CvTargetingChoicesSchema } from "@col/core/cv-targeting";
import { requireVerifiedUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { actionError, zUuid } from "@/lib/validation";

const Input = z.object({
  expectedRevision: z.number().int().nonnegative(),
  expectedSource: CvTargetingBriefSchema.shape.source,
  expectedRubricKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  requestKey: z.string().uuid(),
  choices: CvTargetingChoicesSchema,
});
export type CvTargetingActionInput = z.input<typeof Input>;
export type CvTargetingActionResult = { ok: true; destination: string } | { ok: false; error: string };

const resultError = (error: unknown): CvTargetingActionResult => {
  if (error instanceof CvTargetingConfirmationError) return { ok: false, error: error.message };
  const result = actionError(error, "Could not save these CV choices. Reload the CV and try again.");
  return { ok: false, error: result.ok ? "Could not save these CV choices." : result.error };
};

/** Confirm this build's rubric-bound choices; no new draft or CV credit is created. */
export async function confirmCvTargetingPriorities(draftId: string, raw: CvTargetingActionInput): Promise<CvTargetingActionResult> {
  const user = await requireVerifiedUser();
  const parsed = Input.safeParse(raw);
  if (!zUuid().safeParse(draftId).success || !parsed.success || !parsed.data.expectedRubricKey)
    return { ok: false, error: "Reload the CV and choose its current priorities." };
  try {
    await confirmCvTargetingPrioritiesForUser(db(), user.id, draftId,
      { ...parsed.data, expectedRubricKey: parsed.data.expectedRubricKey });
  } catch (error) { return resultError(error); }
  revalidatePath(`/cv/${draftId}`);
  return { ok: true, destination: `/cv/${draftId}` };
}

/** Change this failed CV's own page choices and resume its original build, without a new draft. */
export async function reviseFailedCvTargeting(draftId: string, raw: CvTargetingActionInput): Promise<CvTargetingActionResult> {
  const user = await requireVerifiedUser();
  const parsed = Input.safeParse(raw);
  if (!zUuid().safeParse(draftId).success || !parsed.success || !parsed.data.expectedRubricKey)
    return { ok: false, error: "Reload this CV and choose its current page limit and sections." };
  try {
    await confirmCvTargetingPrioritiesForUser(db(), user.id, draftId,
      { ...parsed.data, expectedRubricKey: parsed.data.expectedRubricKey }, {
        recoverFailedPageFit: true,
        beforeDraftLock: async tx => { await assertCvBuildCapacity(tx, user.id); },
        beforeQueue: async (tx, draft) => {
          if (draft.buildCheckpoint?.tailoringEnabled || draft.buildCheckpoint?.mode === "improve")
            await reserveCvCredit(tx, user.id, draftId);
        },
      });
  } catch (error) { return resultError(error); }
  revalidatePath(`/cv/${draftId}`);
  return { ok: true, destination: `/cv/${draftId}` };
}
