/**
 * Scheduled entry point for a deployment without a separate worker service.
 *
 * Vercel Cron calls this once a day with `Authorization: Bearer $CRON_SECRET`. It runs a
 * scheduler tick, which queues the daily run and the weekly jobs on their day. It also works
 * through the queue itself, but only where `AVA_SERVERLESS_FALLBACK=1` says that is the
 * whole of the deployment: the tasks it runs are bounded by `maxDuration` and can never launch a
 * browser, so it is a fallback rather than a second worker. Anything unfinished stays queued.
 *
 * Safe to leave enabled alongside a Render worker: a worker that reported in the last two minutes
 * owns both the schedule and the queue, and this route stands down without touching either.
 */
import { getWorkerHeartbeat } from "@/lib/queries/health";
import { NextResponse } from "next/server";
import { claimTask, createDeps, handlers, readEnv, schedulerTick, TaskQueue } from "@ava/worker";
import { renamedEnv } from "@ava/core";
import { getCurrentUser } from "@/lib/auth";
import { timingSafeEqual } from "node:crypto";

function bearerMatches(header: string | null, secret: string): boolean {
  const supplied = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export const dynamic = "force-dynamic";
/**
 * Seconds. 60 is the ceiling on Vercel's Hobby plan; raise it (up to 300) on a paid plan so a
 * large run finishes in one invocation. Work left over is picked up by the next call.
 */
export const maxDuration = 60;

/** Stop claiming new work with enough time left to finish the one in hand and respond. */
const RESERVE_MS = 20_000;

/**
 * Two ways in: the bearer token Vercel Cron sends, or an administrator's signed-in session, so a
 * run can be started by hand from the browser when there is no worker service to pick the work up.
 */
async function authorised(request: Request): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const secret = process.env.CRON_SECRET;
  if (secret && bearerMatches(request.headers.get("authorization"), secret)) return { ok: true };

  if (process.env.SESSION_SECRET) {
    const current = await getCurrentUser().catch(() => null);
    if (current?.user.role === "admin") return { ok: true };
    if (current) return { ok: false, status: 403, error: "administrators only" };
  }
  if (!secret) return { ok: false, status: 503, error: "CRON_SECRET is not set" };
  return { ok: false, status: 401, error: "unauthorised" };
}

/** A worker that reported this recently owns the schedule and the queue; the route stands down. */
const HEARTBEAT_FRESH_MS = 120_000;

async function runScheduledWork(budgetMs: number) {
  // A serverless invocation must never launch a browser: there is no Chromium in the runtime.
  process.env.AVA_DISABLE_BROWSER = "1";
  const started = Date.now();
  const processed: string[] = [];
  let timedOut = false;

  // Read the heartbeat before anything is queued: beside a healthy worker this route does nothing
  // at all, rather than racing it to schedule the same day's run.
  const heartbeat = await getWorkerHeartbeat();
  if (heartbeat && Date.now() - heartbeat.at.getTime() < HEARTBEAT_FRESH_MS) {
    return { processed: 0, byType: {} as Record<string, number>, durationMs: Date.now() - started, timedOut, standDown: "worker" as const };
  }

  const deps = await createDeps(readEnv(), { settingsTtlMs: 0 });
  const queue = new TaskQueue(deps, handlers, { concurrency: 1, workerId: "vercel-cron" });
  const drains = renamedEnv(process.env, "AVA_SERVERLESS_FALLBACK", "CHRISTOPHER_SERVERLESS_FALLBACK") === "1";

  try {
    await schedulerTick(deps);
    while (drains && Date.now() - started < budgetMs) {
      const task = await claimTask(deps.db, "vercel-cron");
      if (!task) break;
      await queue.runTask(task);
      processed.push(task.type);
      if (Date.now() - started >= budgetMs) {
        timedOut = true;
        break;
      }
    }
  } finally {
    await deps.close();
  }

  const counts: Record<string, number> = {};
  for (const type of processed) counts[type] = (counts[type] ?? 0) + 1;
  return { processed: processed.length, byType: counts, durationMs: Date.now() - started, timedOut, drained: drains };
}

export async function GET(request: Request) {
  const auth = await authorised(request);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  try {
    const budgetMs = Math.max(10_000, maxDuration * 1000 - RESERVE_MS);
    const result = await runScheduledWork(budgetMs);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}

/** Same work, for triggering a run by hand: POST with the bearer token, or visit it while signed in. */
export const POST = GET;
