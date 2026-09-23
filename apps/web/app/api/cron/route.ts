/**
 * Scheduled entry point for a deployment without a separate worker service.
 *
 * Vercel Cron calls this once a day with `Authorization: Bearer $CRON_SECRET`. It runs a
 * scheduler tick, which queues the daily run and the weekly jobs on their day. It also works
 * through the queue itself, but only where `AVA_SERVERLESS_FALLBACK=1` says that is the
 * whole of the deployment: each task it runs is cut off before `maxDuration`, it never launches a
 * browser and it never starts a CV build, so it is a fallback rather than a second worker. A task
 * cut off goes back on the queue for the next call, with the attempt counted.
 *
 * Safe to leave enabled alongside a Render worker: a worker that reported in the last two minutes
 * owns both the schedule and the queue, and this route stands down without touching either.
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getCurrentUser } from "@/lib/auth";
import { sessionSecret } from "@/lib/session";
import { runScheduledWork } from "./scheduled-work";

function bearerMatches(header: string | null, secret: string): boolean {
  const supplied = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** The browser names the page a POST came from; a cross-site one names another origin. */
function sameOrigin(request: Request): boolean {
  const url = new URL(request.url);
  return request.headers.get("origin") === `${url.protocol}//${request.headers.get("host") ?? url.host}`;
}

export const dynamic = "force-dynamic";
/**
 * Seconds. 60 is the ceiling on Vercel's Hobby plan; raise it (up to 300) on a paid plan so a
 * large run finishes in one invocation. Work left over is picked up by the next call.
 */
export const maxDuration = 60;

/** Kept after the hard stop to record the outcome of the task in hand and answer. */
const RESPOND_MS = 10_000;
/** A new task is claimed only with at least this long left before the hard stop. */
const MIN_RUN_MS = 20_000;

type Verdict = { ok: true } | { ok: false; status: number; error: string; allow?: string };

/**
 * Two ways in: the bearer token Vercel Cron sends, on either method, or a signed-in administrator's
 * POST from this site, so a run can be started by hand when there is no worker service to pick the
 * work up. The session cookie is SameSite=Lax, which a cross-site top-level GET still carries, so a
 * session never starts a run through GET.
 */
async function authorised(request: Request): Promise<Verdict> {
  const secret = process.env.CRON_SECRET;
  if (secret && bearerMatches(request.headers.get("authorization"), secret)) return { ok: true };

  if (sessionSecret()) {
    const current = await getCurrentUser().catch(() => null);
    if (current) {
      if (current.user.role !== "admin") return { ok: false, status: 403, error: "administrators only" };
      if (request.method !== "POST") return { ok: false, status: 405, error: "a signed-in run must be started with a POST from this site", allow: "POST" };
      if (!sameOrigin(request)) return { ok: false, status: 403, error: "invalid request origin" };
      return { ok: true };
    }
  }
  if (!secret) return { ok: false, status: 503, error: "CRON_SECRET is not set" };
  return { ok: false, status: 401, error: "unauthorised" };
}

async function handle(request: Request) {
  const auth = await authorised(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status, headers: auth.allow ? { allow: auth.allow } : undefined });
  }
  try {
    const hardStopMs = maxDuration * 1000 - RESPOND_MS;
    const result = await runScheduledWork({ hardStopMs, claimForMs: hardStopMs - MIN_RUN_MS });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // The message can carry connection or query text; it goes to the log, not to the caller.
    console.error(JSON.stringify({ event: "cron_failed", error: (err as Error)?.message }));
    return NextResponse.json({ ok: false, error: "scheduled run failed" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

/** Same work, for a run started by hand: with the bearer token, or by a signed-in administrator on this site. */
export async function POST(request: Request) {
  return handle(request);
}
