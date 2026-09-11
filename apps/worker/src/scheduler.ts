import { schema, enqueueTask } from "@christopher/db";
import { dedupeKeyFor, localDateParts, priorityFor } from "@christopher/core";
import { and, eq, lt, sql } from "drizzle-orm";
import type { WorkerDeps } from "./context";
import { maintainHistory } from "./maintenance";
import { log } from "./log";
import { finaliseScanRuns } from "./handlers/daily";
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
    await deps.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('christopher:weekly-jobs'))`);
    const last = await getInternal<string>(tx as unknown as WorkerDeps["db"], "lastWeeklyYmd");
    if (last !== ymd) {
      await setInternal(tx as unknown as WorkerDeps["db"], "lastWeeklyYmd", ymd);
      for (const type of ["suggest_filters", "synthesize_profile", "suggest_companies"] as const) {
        if (type === "suggest_companies" && !settings.suggestionsEnabled) continue;
        const payload = type === "synthesize_profile" ? { force: false } : {};
        await enqueueTask(tx as unknown as WorkerDeps["db"], type, payload, { dedupeKey: dedupeKeyFor(type, payload as never), priority: priorityFor(type) });
      }
      log.info("scheduled weekly jobs", { ymd });
    }
    });
  }

  if (settings.suggestionsEnabled) {
    const due = await deps.db.select().from(schema.discoverySources).where(and(
      eq(schema.discoverySources.enabled, true), sql`${schema.discoverySources.nextRunAt} <= ${now}`,
    ));
    for (const source of due) {
      await enqueueTask(deps.db, "monitor_source", { sourceId: source.id }, {
        dedupeKey: dedupeKeyFor("monitor_source", { sourceId: source.id }), priority: 7,
      });
    }
  }

  await finaliseScanRuns(deps);

  const requeued = await requeueStale(deps.db);
  if (requeued) log.warn("requeued stale tasks", { requeued });

  await deps.db
    .update(schema.companySuggestions)
    .set({ status: "expired", resolvedAt: now })
    .where(and(eq(schema.companySuggestions.status, "pending"), lt(schema.companySuggestions.createdAt, new Date(now.getTime() - 30 * 86_400_000))));

  await maintainHistory(deps);
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
