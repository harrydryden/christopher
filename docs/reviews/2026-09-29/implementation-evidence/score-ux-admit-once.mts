import { createDeps } from "/Users/h_dryden/Documents/New project/christopher-jtbd-review/apps/worker/src/context.ts";
import { readEnv } from "/Users/h_dryden/Documents/New project/christopher-jtbd-review/apps/worker/src/env.ts";
import { claimTask, assertRunOwnership, completeTask } from "/Users/h_dryden/Documents/New project/christopher-jtbd-review/apps/worker/src/queue.ts";
import { handleAdmitScores } from "/Users/h_dryden/Documents/New project/christopher-jtbd-review/apps/worker/src/score-admission.ts";
import { TASK_TYPE_NAMES } from "/Users/h_dryden/Documents/New project/christopher-jtbd-review/packages/core/src/tasks.ts";
import { sql } from "/Users/h_dryden/Documents/New project/christopher-jtbd-review/apps/worker/node_modules/drizzle-orm/index.js";

const expected = process.argv[2];
if (!expected) throw new Error("Pass the exact admission task UUID");
const deps = await createDeps(readEnv(), { settingsTtlMs: 0 });
try {
  if (deps.ai.enabled) throw new Error("Refusing: this local check must have AI disabled");
  const before = await deps.db.execute(sql`select id, payload from tasks where type = 'admit_scores' and status = 'queued' and run_after <= now()`);
  if (before.rows.length !== 1 || before.rows[0]?.id !== expected) throw new Error(`Expected only admission ${expected}; found ${before.rows.map((r: any) => r.id).join(",")}`);
  const payload = before.rows[0]!.payload as { userId: string; jobIds: string[] };
  if (payload.jobIds.length !== 1) throw new Error("Expected one exact role in admission payload");
  const roleId = payload.jobIds[0]!;
  const prior = await deps.db.execute(sql`select score_state, fit_score from user_jobs where user_id = ${payload.userId}::uuid and job_id = ${roleId}::uuid`);
  const callsBefore = await deps.db.execute(sql`select count(*)::int as n from ai_calls`);
  const workerId = "score-ux-harness";
  const excluded = TASK_TYPE_NAMES.filter(type => type !== "admit_scores");
  const task = await claimTask(deps.db, workerId, "all", excluded);
  if (!task || task.id !== expected) throw new Error("The queue did not claim the expected admission task");
  const stop = new AbortController();
  const runDeps = { ...deps, signal: stop.signal, ai: deps.ai.withSignal(stop.signal), assertOwnership: (db: typeof deps.db) => assertRunOwnership(db, task, stop.signal) };
  const result = await handleAdmitScores(task, runDeps);
  const completed = await completeTask(deps.db, task, result);
  const after = await deps.db.execute(sql`select score_state, fit_score from user_jobs where user_id = ${payload.userId}::uuid and job_id = ${roleId}::uuid`);
  const taskAfter = await deps.db.execute(sql`select status, result from tasks where id = ${expected}::uuid`);
  const callsAfter = await deps.db.execute(sql`select count(*)::int as n from ai_calls`);
  const scoreTasks = await deps.db.execute(sql`select count(*)::int as n from tasks where type = 'score_job' and payload->>'userId' = ${payload.userId} and payload->>'jobId' = ${roleId}`);
  console.log(JSON.stringify({ workerId, taskId: expected, roleId, before: prior.rows[0], taskClaimed: task.status, ownershipFenced: true, handlerResult: result,
    completed, after: after.rows[0], taskAfter: taskAfter.rows[0], aiCallsBefore: callsBefore.rows[0]?.n, aiCallsAfter: callsAfter.rows[0]?.n,
    scoreTasksForRole: scoreTasks.rows[0]?.n }, null, 2));
} finally {
  await deps.close();
}
