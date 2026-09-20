"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { setUserSetting } from "@/lib/settings";

/**
 * Hide the setup checklist card on Roles. The checklist itself stays derived from rows, so this
 * changes nothing about what is done — and an account with nothing in its table still sees it,
 * because there a blank table needs the explanation more than the person needs the space.
 */
export async function dismissSetupChecklist(): Promise<void> {
  const user = await requireUser();
  await setUserSetting(user.id, "setupDismissedAt", new Date().toISOString());
  revalidatePath("/");
}
