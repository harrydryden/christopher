import { accountCanScore, enqueueStandard, enqueueTasks, taskRow, type Task } from "@ava/db";
import type { TaskPayloads } from "@ava/core";
import { sql } from "drizzle-orm";
import type { WorkerDeps } from "../context";

const PAGE_SIZE = 100;

/** Fan out reasons saved before confirmation without making the claim transaction grow with history. */
export async function handleResumeReasonTags(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { userId, afterDecisionId } = (task.payload ?? {}) as TaskPayloads["resume_reason_tags"];
  if (!userId) return { skipped: "no account on task" };
  return deps.db.transaction(async tx => {
    await deps.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
    if (!await accountCanScore(tx as unknown as WorkerDeps["db"], userId))
      return { skipped: "account missing or email confirmation required" };
    const page = await tx.execute<{ id: string }>(sql`
      select id from decisions
      where user_id = ${userId}::uuid and id > ${afterDecisionId ?? "00000000-0000-0000-0000-000000000000"}::uuid
        and superseded = false and tags_edited = false and jsonb_array_length(tags) = 0
        and length(btrim(reason)) > 0
      order by id limit ${PAGE_SIZE}`);
    const ids = page.rows.map(row => row.id);
    await enqueueTasks(tx, ids.map(decisionId => taskRow("tag_reason", { decisionId })), PAGE_SIZE);
    if (ids.length === PAGE_SIZE)
      await enqueueStandard(tx, "resume_reason_tags", { userId, afterDecisionId: ids.at(-1) });
    return { queued: ids.length, continuing: ids.length === PAGE_SIZE };
  });
}
