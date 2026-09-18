import { schema, abandonCvDraft, enqueueTask, listUserIds, pruneWorkerEvents, releaseAiHolds } from "@christopher/db";
import { dedupeKeyFor, localDateParts, priorityFor } from "@christopher/core";
import { and, eq, lt, sql } from "drizzle-orm";
import type { WorkerDeps } from "./context";
import { maintainHistory } from "./maintenance";
import { log } from "./log";
import { finaliseScanRuns } from "./handlers/daily";
import { CV_ABANDONED_MESSAGE, onAbandon } from "./handlers/abandon";
import { agePriorities, requeueStale } from "./queue";
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

  // One shared daily run: every company anyone follows, scanned once.
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

  // Weekly learning jobs run per account, an hour after the daily run.
  if (weekday === settings.weeklyDay && hm >= addMinutes(settings.scanTime, 60)) {
    await deps.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('christopher:weekly-jobs'))`);
    const last = await getInternal<string>(tx as unknown as WorkerDeps["db"], "lastWeeklyYmd");
    if (last !== ymd) {
      await setInternal(tx as unknown as WorkerDeps["db"], "lastWeeklyYmd", ymd);
      const users = await listUserIds(tx as unknown as WorkerDeps["db"]);
      for (const userId of users) {
        const account = await deps.userSettings(userId);
        const jobs: Array<{ type: "suggest_filters" | "synthesize_profile" | "suggest_companies"; payload: Record<string, unknown> }> = [
          { type: "suggest_filters", payload: { userId } },
          { type: "synthesize_profile", payload: { userId, force: false } },
        ];
        if (account.suggestionsEnabled) jobs.push({ type: "suggest_companies", payload: { userId } });
        for (const job of jobs) {
          await enqueueTask(tx as unknown as WorkerDeps["db"], job.type, job.payload, { dedupeKey: dedupeKeyFor(job.type, job.payload as never), priority: priorityFor(job.type) });
        }
      }
      log.info("scheduled weekly jobs", { ymd, accounts: users.length });
    }
    });
  }

  // External discovery sources are checked on their own interval; the handler honours the owner's settings.
  const due = await deps.db.select().from(schema.discoverySources).where(and(
    eq(schema.discoverySources.enabled, true), sql`${schema.discoverySources.nextRunAt} <= ${now}`,
  ));
  for (const source of due) {
    if (!(await deps.userSettings(source.userId)).suggestionsEnabled) continue;
    await enqueueTask(deps.db, "monitor_source", { sourceId: source.id }, {
      dedupeKey: dedupeKeyFor("monitor_source", { sourceId: source.id }), priority: 7,
    });
  }

  await finaliseScanRuns(deps);

  const recovered = await requeueStale(deps.db, undefined, deps.env.workerId, { deps, onAbandon });
  if (recovered.requeued || recovered.failed) log.warn("recovered tasks from a lost worker", recovered);

  // Every few minutes, and once a day: the sweeps that catch what the queue itself could not.
  await claimPeriodic(deps, "lastCvReconcile", 300, async () => {
    const failed = await reconcileCvDrafts(deps);
    if (failed) log.warn("reconciled CV drafts nothing was building", { failed });
  });
  await prunePeriodically(deps);

  // Ageing, once a minute and bounded, so that a task which keeps losing to newer higher-priority
  // work still reaches the front. It lives here rather than in the claim because the claim's
  // ordering has to be something an index can serve.
  const aged = await agePriorities(deps.db);
  if (aged) log.debug("aged queued tasks", { aged });

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

/** Run `work` at most once every `seconds`, whichever worker or tick gets there first. */
async function claimPeriodic(deps: WorkerDeps, key: string, seconds: number, work: () => Promise<void>): Promise<void> {
  const claimed = await deps.db.execute(sql`insert into settings (key, value, updated_at) values (${`internal:${key}`}, '{}', now())
    on conflict (key) do update set updated_at = now() where settings.updated_at < now() - make_interval(secs => ${seconds}::int) returning key`);
  if (!claimed.rows.length) return;
  await work();
}

/**
 * CV drafts still building with nothing building them.
 *
 * The queue's own abandonment hook covers the worker that was holding the task. It cannot cover
 * everything: a task row can be deleted by history maintenance, a draft can be left behind by a
 * release that changed the task's shape, and a hook can itself fail on a database that is down.
 * This is the backstop, and it asks the only question that matters — is there still a task that
 * could finish this build? A draft with no queued or running task of its own has nobody coming,
 * whatever failed, and the page must stop saying "generating".
 *
 * The grace period keeps it away from a draft whose task is a moment behind it, and every row it
 * touches is acted on for its own account.
 */
export async function reconcileCvDrafts(deps: WorkerDeps, graceMinutes = 5): Promise<number> {
  const orphans = await deps.db.execute<{ id: string; userId: string }>(sql`
    select d.id, d.user_id as "userId" from cv_drafts d
    where d.status in ('queued', 'generating')
      and coalesce(d.progress_at, d.created_at) < now() - make_interval(mins => ${graceMinutes}::int)
      and not exists (
        select 1 from tasks t
        where t.dedupe_key = 'generate_cv:' || d.id::text and t.status in ('queued', 'running')
      )
    limit 200`);
  let failed = 0;
  for (const orphan of orphans.rows) {
    const abandoned = await abandonCvDraft(deps.db, orphan.id, CV_ABANDONED_MESSAGE);
    if (!abandoned) continue;
    failed++;
    const released = await releaseAiHolds(deps.db, { userId: abandoned.userId, callSite: "CV" });
    log.warn("failed a CV draft no task was building", { draftId: orphan.id, userId: abandoned.userId, holdsReleased: released.count });
  }
  return failed;
}

/** The ledger is a month of history, not an audit trail; trimming it is a once-a-day job. */
async function prunePeriodically(deps: WorkerDeps): Promise<void> {
  await claimPeriodic(deps, "lastWorkerEventPrune", 86_400, async () => {
    const pruned = await pruneWorkerEvents(deps.db);
    if (pruned) log.info("pruned worker events", { pruned });
  });
}
