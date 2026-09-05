import { schema, enqueueTask } from "@christopher/db";
import { dedupeKeyFor, localDateParts, priorityFor } from "@christopher/core";
import { and, eq, lt, sql } from "drizzle-orm";
import type { WorkerDeps } from "./context";
import { log } from "./log";
import { requeueStale } from "./queue";
import { getInternal, setInternal } from "./settings";

function addMinutes(hm: string, minutes: number): string {
  const [h, m] = hm.split(":").map(Number);
  const total = ((h ?? 0) * 60 + (m ?? 0) + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** One scheduler tick. Idempotent: safe to call every minute and after restarts. */
export async function schedulerTick(deps: WorkerDeps): Promise<void> {
  const settings = await deps.settings();
  const now = deps.now();
  const { ymd, hm, weekday } = localDateParts(now, settings.timezone);

  if (hm >= settings.scanTime) {
    const existing = await deps.db
      .select({ id: schema.scanRuns.id })
      .from(schema.scanRuns)
      .where(and(eq(schema.scanRuns.runDate, ymd), eq(schema.scanRuns.trigger, "schedule")))
      .limit(1);
    if (existing.length === 0) {
      const payload = { trigger: "schedule" as const, runDate: ymd };
      const id = await enqueueTask(deps.db, "run_daily", payload, { dedupeKey: dedupeKeyFor("run_daily", payload), priority: priorityFor("run_daily") });
      if (id) log.info("scheduled daily run", { ymd, scanTime: settings.scanTime, tz: settings.timezone });
    }
  }

  if (weekday === settings.weeklyDay && hm >= addMinutes(settings.scanTime, 60)) {
    const last = await getInternal<string>(deps.db, "lastWeeklyYmd");
    if (last !== ymd) {
      await setInternal(deps.db, "lastWeeklyYmd", ymd);
      for (const type of ["suggest_filters", "synthesize_profile", "suggest_companies"] as const) {
        if (type === "suggest_companies" && !settings.suggestionsEnabled) continue;
        const payload = type === "synthesize_profile" ? { force: false } : {};
        await enqueueTask(deps.db, type, payload, { dedupeKey: dedupeKeyFor(type, payload as never), priority: priorityFor(type) });
      }
      log.info("scheduled weekly jobs", { ymd });
    }
  }

  const requeued = await requeueStale(deps.db);
  if (requeued) log.warn("requeued stale tasks", { requeued });

  await deps.db
    .update(schema.companySuggestions)
    .set({ status: "expired", resolvedAt: now })
    .where(and(eq(schema.companySuggestions.status, "pending"), lt(schema.companySuggestions.createdAt, new Date(now.getTime() - 30 * 86_400_000))));

  await deps.db.execute(sql`delete from tasks where status = 'done' and finished_at < now() - interval '14 days'`);
}

export function startScheduler(deps: WorkerDeps, intervalMs = 60_000): { stop(): void } {
  let timer: NodeJS.Timeout | null = null;
  const run = async () => {
    try {
      await schedulerTick(deps);
    } catch (err) {
      log.error("scheduler tick failed", err);
    }
  };
  void run();
  timer = setInterval(run, intervalMs);
  return {
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
