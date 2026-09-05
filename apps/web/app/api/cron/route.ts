/**
 * Scheduled entry point for a deployment without a separate worker service.
 *
 * Vercel Cron calls this once a day with `Authorization: Bearer $CRON_SECRET`. It runs a
 * scheduler tick (which queues the daily run, and the weekly jobs on their day) and then works
 * through the queue until it runs out of time, leaving anything unfinished for the next call.
 *
 * Harmless to leave enabled alongside a Render worker: task claiming is atomic and the scan run
 * is deduplicated per day, so whichever gets there first does the work.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { claimTask, createDeps, handlers, readEnv, schedulerTick, TaskQueue } from "@christopher/worker";
import { SESSION_COOKIE_NAME, verifySessionCookieValue } from "@/lib/session";

export const dynamic = "force-dynamic";
/**
 * Seconds. 60 is the ceiling on Vercel's Hobby plan; raise it (up to 300) on a paid plan so a
 * large run finishes in one invocation. Work left over is picked up by the next call.
 */
export const maxDuration = 60;

/** Stop claiming new work with enough time left to finish the one in hand and respond. */
const RESERVE_MS = 20_000;

/**
 * Two ways in: the bearer token Vercel Cron sends, or a signed-in session, so a run can be
 * started by hand from the browser when there is no worker service to pick the work up.
 */
async function authorised(request: Request): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) return { ok: true };

  const sessionSecret = process.env.SESSION_SECRET;
  if (sessionSecret) {
    const cookie = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (await verifySessionCookieValue(cookie, sessionSecret)) return { ok: true };
  }
  if (!secret) return { ok: false, status: 503, error: "CRON_SECRET is not set" };
  return { ok: false, status: 401, error: "unauthorised" };
}

async function runScheduledWork(budgetMs: number) {
  // A serverless invocation must never launch a browser: there is no Chromium in the runtime.
  process.env.CHRISTOPHER_DISABLE_BROWSER = "1";
  const deps = await createDeps(readEnv(), { settingsTtlMs: 0 });
  const queue = new TaskQueue(deps, handlers, { concurrency: 1, workerId: "vercel-cron" });
  const started = Date.now();
  const processed: string[] = [];
  let timedOut = false;

  try {
    await schedulerTick(deps);
    while (Date.now() - started < budgetMs) {
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
  return { processed: processed.length, byType: counts, durationMs: Date.now() - started, timedOut };
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
