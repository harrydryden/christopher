import { schema, abandonCvDraft, enqueueTask, pruneWorkerEvents, recordWorkerEvent, releaseAiHolds, releaseOrphanedCvHolds } from "@ava/db";
import { enqueueTasks, type EnqueueRow } from "@ava/db/tasks";
import { dedupeKeyFor, localDateParts, priorityFor, resolveUserSettings, type TaskType } from "@ava/core";
import { and, eq, lt, sql } from "drizzle-orm";
import type { WorkerDeps } from "./context";
import { maintainHistory } from "./maintenance";
import { log } from "./log";
import { finaliseScanRuns } from "./handlers/daily";
import { CV_ABANDONED_MESSAGE, cvInterruptedFailure, onAbandon } from "./handlers/abandon";
import { failOpenCvBuildStepsQuietly } from "./handlers/cv-journal";
import { agePriorities, failSpentTasks, requeueStale } from "./queue";
import { getInternal, setInternal } from "./settings";

/** Past this many due discovery sources, one tick leaves the rest for the next. */
const DISCOVERY_SWEEP_LIMIT = 200;

/** An account's own `suggestionsEnabled`, from its stored value, resolved as its settings are. */
function suggestionsEnabled(stored: unknown): boolean {
  return resolveUserSettings(stored === null || stored === undefined ? [] : [{ key: "suggestionsEnabled", value: stored }]).suggestionsEnabled;
}

function addMinutes(hm: string, minutes: number): string {
  const [h, m] = hm.split(":").map(Number);
  const total = ((h ?? 0) * 60 + (m ?? 0) + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * One scheduler tick. Idempotent: safe to call every minute and after restarts.
 *
 * `signal` is the scheduler being stopped: the tick returns at the next step rather than carrying
 * on into a pool the shutdown is about to close. Every step is safe to leave for the next tick.
 */
export async function schedulerTick(deps: WorkerDeps, signal?: AbortSignal): Promise<void> {
  const stopped = () => signal?.aborted === true;
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
  if (stopped()) return;
  if (weekday === settings.weeklyDay && hm >= addMinutes(settings.scanTime, 60)) {
    await deps.db.transaction(async tx => {
      const writer = tx as unknown as WorkerDeps["db"];
      await writer.execute(sql`select pg_advisory_xact_lock(hashtext('ava:weekly-jobs'))`);
      if ((await getInternal<string>(writer, "lastWeeklyYmd")) === ymd) return;
      await setInternal(writer, "lastWeeklyYmd", ymd);
      // One read of every account's suggestions switch and one batched insert, inside the lock
      // with the marker, so the week is scheduled whole or not at all. It used to be a settings
      // read and three inserts per account, one after another, all under the lock.
      const accounts = await writer.execute<{ id: string; suggestions: unknown }>(sql`select u.id, us.value as suggestions
        from users u left join user_settings us on us.user_id = u.id and us.key = 'suggestionsEnabled'
        where u.claimed_at is not null`);
      const job = (type: TaskType, payload: Record<string, unknown>): EnqueueRow =>
        ({ type, payload, dedupeKey: dedupeKeyFor(type, payload as never), priority: priorityFor(type) });
      const rows = accounts.rows.flatMap(({ id: userId, suggestions }) => [
        job("suggest_filters", { userId }),
        job("synthesize_profile", { userId, force: false }),
        ...(suggestionsEnabled(suggestions) ? [job("suggest_companies", { userId })] : []),
      ]);
      const queued = await enqueueTasks(writer, rows);
      log.info("scheduled weekly jobs", { ymd, accounts: accounts.rows.length, queued });
    });
  }

  // External discovery sources are checked on their own interval. A due source is leased a day
  // ahead as it is read, and the handler moves it to its real next run when it finishes, so one
  // whose task fails, times out or dies with its worker is not queued again on every tick. Its
  // owner's suggestions switch comes from the same statement; a source whose owner has them off
  // is looked at again in an hour, where it used to be read — with its owner's settings — every
  // minute for as long as the switch stayed off.
  if (stopped()) return;
  const due = await deps.db.execute<{ id: string; suggestions: unknown }>(sql`
    update discovery_sources ds
    set next_run_at = ${now}::timestamptz + case when due.suggestions = 'false'::jsonb then interval '1 hour' else interval '1 day' end
    from (
      select s.id, us.value as suggestions
      from discovery_sources s
      left join user_settings us on us.user_id = s.user_id and us.key = 'suggestionsEnabled'
      where s.enabled = true and s.next_run_at <= ${now}
      order by s.next_run_at
      limit ${DISCOVERY_SWEEP_LIMIT}
      for update of s skip locked
    ) due
    where ds.id = due.id
    returning ds.id, due.suggestions`);
  await enqueueTasks(deps.db, due.rows.filter(source => suggestionsEnabled(source.suggestions)).map(source => ({
    type: "monitor_source" as const, payload: { sourceId: source.id },
    dedupeKey: dedupeKeyFor("monitor_source", { sourceId: source.id }), priority: 7,
  })));

  if (stopped()) return;
  await finaliseScanRuns(deps);

  if (stopped()) return;
  const recovered = await requeueStale(deps.db, undefined, deps.env.workerId, { deps, onAbandon });
  if (recovered.requeued || recovered.failed) log.warn("recovered tasks from a lost worker", recovered);
  // Boot sweeps these too; hourly is enough for a state nothing current produces.
  await claimPeriodic(deps, "lastSpentSweep", 3600, async () => {
    const spent = await failSpentTasks(deps.db, deps.env.workerId, { deps, onAbandon });
    if (spent) log.warn("failed queued tasks that had spent every attempt", { spent });
  });

  // Every few minutes, and once a day: the sweeps that catch what the queue itself could not.
  if (stopped()) return;
  await claimPeriodic(deps, "lastCvReconcile", 300, async () => {
    const failed = await reconcileCvDrafts(deps);
    if (failed) log.warn("reconciled CV drafts nothing was building", { failed });
  });
  await prunePeriodically(deps);

  if (stopped()) return;
  // Ageing, once a minute and bounded, so that a task which keeps losing to newer higher-priority
  // work still reaches the front. It lives here rather than in the claim because the claim's
  // ordering has to be something an index can serve. Claimed across the deployment, because every
  // worker and the cron fallback tick: each sweep is one step, and two a minute is twice the rate.
  await claimPeriodic(deps, "lastAgePriorities", 55, async () => {
    const aged = await agePriorities(deps.db);
    if (aged) log.debug("aged queued tasks", { aged });
  });

  await deps.db
    .update(schema.companySuggestions)
    .set({ status: "expired", resolvedAt: now })
    .where(and(eq(schema.companySuggestions.status, "pending"), lt(schema.companySuggestions.createdAt, new Date(now.getTime() - 30 * 86_400_000))));

  if (stopped()) return;
  await maintainHistory(deps);
}

/**
 * Tick now and then every `intervalMs`, one tick at a time.
 *
 * The next tick is scheduled when the last one finishes, so a tick that outlasts the interval —
 * the weekly fan-out, a maintenance batch, a lock the daily run holds — delays the next instead
 * of running beside it and doubling its connections. `stop()` tells the tick in flight to return
 * at its next step and resolves once it has, so a shutdown never closes the pool under it.
 */
export function startScheduler(
  deps: WorkerDeps,
  intervalMs = 60_000,
  tick: (deps: WorkerDeps, signal: AbortSignal) => Promise<void> = schedulerTick,
): { stop(): Promise<void> } {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<void> | null = null;
  const run = () => {
    if (controller.signal.aborted) return;
    timer = null;
    const started = Date.now();
    current = tick(deps, controller.signal)
      .catch(err => log.error("scheduler tick failed", err))
      .finally(() => {
        current = null;
        if (!controller.signal.aborted) timer = setTimeout(run, Math.max(0, intervalMs - (Date.now() - started)));
      });
  };
  run();
  return {
    async stop() {
      controller.abort();
      if (timer) clearTimeout(timer);
      await current;
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
        where t.type = 'generate_cv'
          and t.payload->>'draftId' = d.id::text
          and t.status in ('queued', 'running')
      )
    limit 200`);
  let failed = 0;
  for (const orphan of orphans.rows) {
    // No task is left to read an attempt count from, so the record names what happened and who
    // moves next without one; the page never shows a bare "interrupted" without its taxonomy.
    const failure = cvInterruptedFailure();
    const abandoned = await abandonCvDraft(deps.db, orphan.id, CV_ABANDONED_MESSAGE, failure);
    if (!abandoned) continue;
    await failOpenCvBuildStepsQuietly(deps.db, orphan.id, CV_ABANDONED_MESSAGE, failure);
    failed++;
    // This build's hold alone: the account may have another build running, whose hold is its own
    // and whose renewal would otherwise silently stop matching a row.
    const released = await releaseAiHolds(deps.db, { userId: abandoned.userId, callSite: "CV", refId: orphan.id });
    log.warn("failed a CV draft no task was building", { draftId: orphan.id, userId: abandoned.userId, holdsReleased: released.count });
  }
  // Holds outlive their builds when the pod that took them dies under another name or the draft
  // is discarded mid-build; a boot releases only its own pod's holds, so the sweep takes the rest.
  const orphanedHolds = await releaseOrphanedCvHolds(deps.db);
  if (orphanedHolds.count) {
    log.warn("released CV holds with no build behind them", orphanedHolds);
    await recordWorkerEvent(deps.db, { workerId: deps.env.workerId, kind: "holds_released", detail: { ...orphanedHolds, reason: "orphaned" } });
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
