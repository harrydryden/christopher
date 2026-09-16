"use server";

import { requireAdmin } from "@/lib/auth";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { tasks } from "@christopher/db/schema";
import { db } from "@/lib/db";
import { zUuid } from "@/lib/validation";

/** The queue is shared by every account, so only an administrator restarts its failures. */
export async function retryTask(taskId: string): Promise<void> {
  await requireAdmin();
  const id = zUuid().parse(taskId);
  await db()
    .update(tasks)
    .set({ status: "queued", attempts: 0, error: null, lockedAt: null, lockedBy: null, startedAt: null, finishedAt: null })
    .where(eq(tasks.id, id));
  revalidatePath("/health");
}
