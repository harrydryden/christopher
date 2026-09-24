"use server";
/**
 * Opening, ending and answering a share link. Three small writes, all of them the owner's.
 *
 * Every one of them starts with `requireUser()`, and opening a link additionally re-reads the
 * draft through `getOwnCvDraft` — a share is a promise about one revision of one CV, so the
 * account that makes the promise has to own the thing being promised. Revoking and resolving are
 * scoped by the account in the query itself, which is why they need no second lookup.
 *
 * The plain token exists in exactly one place and for exactly one response: it is generated here,
 * hashed for storage, and handed back on the result so the owner can copy it. Nothing reads it
 * again, here or anywhere else — a reloaded page cannot show it, because by then only the hash
 * survives.
 */
import { revalidatePath } from "next/cache";
import {
  createCvShare,
  resolveCvShareComment as resolveCommentRow,
  revokeCvShare,
} from "@ava/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { emailLinkOrigin } from "@/lib/origin";
import { getOwnCvDraft } from "@/lib/queries/cv";
import {
  cvShareDays,
  cvShareExpiry,
  cvSharePath,
  hashCvShareToken,
  newCvShareToken,
  type CvShareResult,
} from "@/lib/cv-share";
import { actionError, fail, zUuid } from "@/lib/validation";

/**
 * Open a link onto one saved revision.
 *
 * The result carries the link because this is the only moment it can: the token is hashed on its
 * way into the database and never stored, exactly as a password reset link is. `days` is the
 * owner's choice, brought inside a fortnight-by-default, ninety-day-maximum policy rather than
 * refused, and comments are on unless the box is cleared.
 */
export async function createCvShareLink(
  draftId: string,
  _prev: CvShareResult,
  form: FormData,
): Promise<CvShareResult> {
  try {
    const user = await requireUser();
    if (!zUuid().safeParse(draftId).success) return fail("That CV could not be found.");
    const draft = await getOwnCvDraft(user.id, draftId);
    if (!draft) return fail("That CV could not be found.");
    if (!draft.content) return fail("This CV has nothing to show yet. Build it before sharing it.");
    if (draft.archivedAt) return fail("This revision has been archived. Share the current one instead.");
    // A reader is shown wording the factual review has passed, and only that: a failed build's
    // wording, or a revision still being written, is not one to send anyone.
    if (draft.status !== "ready" || !draft.assessment)
      return fail("Share this CV once its build and assessment have finished.");

    const token = newCvShareToken();
    const days = cvShareDays(form.get("days"));
    const expiresAt = cvShareExpiry(days);
    await createCvShare(db(), {
      userId: user.id,
      draftId,
      tokenHash: hashCvShareToken(token),
      allowComments: form.get("allowComments") !== null,
      expiresAt,
    });
    revalidatePath(`/cv/${draftId}`);
    const origin = (await emailLinkOrigin()) ?? "";
    return {
      ok: true,
      message: `This link works for ${days} ${days === 1 ? "day" : "days"}, until it is revoked.`,
      link: `${origin}${cvSharePath(token)}`,
      expiresAt: expiresAt.toISOString(),
    };
  } catch (error) {
    return actionError(error, "That link could not be created.", "cv_share_create_failed");
  }
}

/**
 * End a link now. The notes left through it stay: they are the owner's, and revoking is about the
 * link, not about what was said through it.
 */
export async function revokeCvShareLink(id: string, draftId: string): Promise<void> {
  const user = await requireUser();
  if (!zUuid().safeParse(id).success || !zUuid().safeParse(draftId).success) return;
  await revokeCvShare(db(), user.id, id);
  revalidatePath(`/cv/${draftId}`);
}

/** Mark one reader's note dealt with. Scoped by account in the query, so it needs no other check. */
export async function resolveCvShareComment(id: string, draftId: string): Promise<void> {
  const user = await requireUser();
  if (!zUuid().safeParse(id).success || !zUuid().safeParse(draftId).success) return;
  await resolveCommentRow(db(), user.id, id);
  revalidatePath(`/cv/${draftId}`);
}
