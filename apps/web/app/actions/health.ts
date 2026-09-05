"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { tasks } from "@christopher/db/schema";
import { db } from "@/lib/db";
import { zUuid } from "@/lib/validation";

export async function retryTask(taskId: string): Promise<void> {
  const id = zUuid().parse(taskId);
  await db()
    .update(tasks)
    .set({ status: "queued", attempts: 0, error: null, lockedAt: null, lockedBy: null, startedAt: null, finishedAt: null })
    .where(eq(tasks.id, id));
  revalidatePath("/health");
}
