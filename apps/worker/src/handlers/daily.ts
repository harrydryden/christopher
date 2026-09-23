import { companiesDueLogoCapture, retireSourceRoles, scanRunSummary, schema, enqueueTask, type Task } from "@ava/db";
import { dedupeKeyFor, localDateParts, priorityFor, type SystemSettings } from "@ava/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { WorkerDeps } from "../context";
import { log } from "../log";
import { SUGGEST_FROM_SCANS_EVERY_MS } from "./suggest-from-scans";

interface DailyPayload {
  trigger: "schedule" | "manual";
  runDate?: string;
}

/**
 * How many logos one daily run will capture. A logo is decoration and each one costs a homepage
 * read plus an icon read, so the sweep is bounded and takes the oldest attempt first: a catalogue
 * larger than this still works through itself a day at a time, newly followed companies first.
 */
const LOGO_CAPTURES_PER_DAY = 200;

/**
 * Fan out one scan_company task per active company, then a finaliser that summarises the run.
 * A company is active while anyone follows it actively, so the run covers every follower's
 * companies exactly once, however many people follow the same one.
 * Idempotent per (runDate, trigger) so a restart mid-run does not duplicate it.
 */
export async function handleRunDaily(task: Task, deps: WorkerDeps): Promise<unknown> {
  // The timezone is read before the transaction opens: it is an administrator's setting that
  // cannot meaningfully change while the fan-out runs, and reading it from inside would ask the
  // pool for a second connection while this one holds the advisory lock.
  const settings = await deps.settings();
  return deps.db.transaction(async (tx) => {
    await deps.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ava:daily-runs'))`);
    return runDaily(task, { ...deps, db: tx as unknown as WorkerDeps["db"] }, settings);
  });
}

async function runDaily(task: Task, deps: WorkerDeps, settings: SystemSettings): Promise<unknown> {
  const checkpoint = task.result as { scanRunId?: string } | null;
  if (checkpoint?.scanRunId) return task.result;
  const payload = task.payload as unknown as DailyPayload;
  const runDate = payload.runDate ?? localDateParts(deps.now(), settings.timezone).ymd;

  const existing = await deps.db
    .select({ id: schema.scanRuns.id })
    .from(schema.scanRuns)
    .where(and(eq(schema.scanRuns.runDate, runDate), eq(schema.scanRuns.trigger, payload.trigger)))
    .limit(1);
  if (existing.length && payload.trigger === "schedule") {
    return { skipped: "run already exists for date", runDate };
  }

  // Roles of sources nobody scans any more (disabled, superseded, or a company nobody follows) are
  // closed here, once a day, whatever path retired the source: left open they would read as live
  // for ever. A lifecycle event, not a scan closure (see `retireSourceRoles`).
  const retired = await retireSourceRoles(deps.db, {}, deps.now());

  const companies = await deps.db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(and(eq(schema.companies.status, "active"), payload.trigger === "schedule" ? sql`(
      not exists (select 1 from career_sources cs where cs.company_id=${schema.companies.id}) or
      exists (select 1 from career_sources cs where cs.company_id=${schema.companies.id} and cs.status in ('active','failing') and (cs.next_scan_at is null or cs.next_scan_at <= ${deps.now()})))` : undefined));

  const [run] = await deps.db
    .insert(schema.scanRuns)
    .values({ runDate, trigger: payload.trigger, startedAt: deps.now(), companiesTotal: companies.length })
    .returning({ id: schema.scanRuns.id });
  if (!run) throw new Error("failed to create scan run");

  const spreadMs = payload.trigger === "schedule" ? (deps.env.scanSpreadMinutes ?? 60) * 60_000 : 0;
  for (let offset = 0; offset < companies.length; offset += 250) {
    await deps.db.insert(schema.tasks).values(companies.slice(offset, offset + 250).map(company => {
      const p = { companyId: company.id, scanRunId: run.id, trigger: payload.trigger };
      const fraction = Number.parseInt(company.id.replaceAll("-", "").slice(0, 8), 16) / 0xffffffff;
      return { type: "scan_company" as const, payload: p, dedupeKey: `${dedupeKeyFor("scan_company", p)}:${run.id}`,
        priority: priorityFor("scan_company"), runAfter: new Date(deps.now().getTime() + fraction * spreadMs) };
    })).onConflictDoNothing();
  }

  // The logo sweep rides with the scan fan-out rather than on a schedule of its own: it is the
  // once-a-day pass over the catalogue, and a company nobody has captured yet, one whose icon is
  // three months old, and one whose last attempt has finished backing off are all due here. The
  // dedupe key means a sweep that runs twice, or one that runs while yesterday's task is still
  // queued, adds nothing.
  const dueLogos = await companiesDueLogoCapture(deps.db, deps.now(), LOGO_CAPTURES_PER_DAY);
  let logosQueued = 0;
  for (const company of dueLogos) {
    const payload = { companyId: company.id, logoOnly: true, homepageUrl: company.homepageUrl };
    if (await enqueueTask(deps.db, "discover", payload, { dedupeKey: dedupeKeyFor("discover", payload), priority: 6 })) logosQueued++;
  }

  if (task.id) await deps.db.update(schema.tasks).set({ result: { scanRunId: run.id, companies: companies.length } }).where(eq(schema.tasks.id, task.id));
  log.info("daily run started", { runId: run.id, runDate, companies: companies.length, logosQueued, retired });
  return { scanRunId: run.id, companies: companies.length, logosQueued };
}

/** Summarise a scan run once its scans are done. Called after the queue drains and by the scheduler. */
export async function finaliseScanRuns(deps: WorkerDeps): Promise<number> {
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ava:daily-runs'))`);
    return finalise({ ...deps, db: tx as unknown as WorkerDeps["db"] });
  });
}

async function finalise(deps: WorkerDeps): Promise<number> {
  const open = await deps.db
    .select()
    .from(schema.scanRuns)
    .where(sql`${schema.scanRuns.finishedAt} is null`);
  let finalised = 0;
  for (const run of open) {
    const pending = await deps.db.execute<{ n: number }>(sql`
      select count(*)::int as n from tasks
      where type = 'scan_company' and status in ('queued','running') and payload->>'scanRunId' = ${run.id}`);
    if ((pending.rows[0]?.n ?? 0) > 0) continue;

    const summary = await scanRunSummary(deps.db, run.id);
    const companiesOk = Math.min(run.companiesTotal, summary.companies_ok);

    await deps.db
      .update(schema.scanRuns)
      .set({
        finishedAt: deps.now(),
        companiesOk,
        companiesFailed: Math.max(0, run.companiesTotal - companiesOk),
        newRoles: summary.new_roles,
        closedRoles: summary.closed_roles,
      })
      .where(eq(schema.scanRuns.id, run.id));
    finalised++;
    // Fresh evidence: mine it, per account, for keywords each gate is missing. Only accounts that
    // follow a company this run scanned have anything new, and each is mined weekly, so accounts
    // mined in the last six days are left out here rather than queued to skip. One statement for
    // every account, instead of an insert apiece while the daily-runs lock is held.
    const minedSince = new Date(deps.now().getTime() - SUGGEST_FROM_SCANS_EVERY_MS);
    await deps.db.execute(sql`insert into tasks (type, payload, dedupe_key, priority)
      select 'suggest_from_scans', jsonb_build_object('userId', u.id, 'scheduled', true), 'suggest_from_scans:' || u.id::text, ${priorityFor("suggest_from_scans")}
      from users u
      where u.claimed_at is not null
        and exists (select 1 from company_subscriptions s
          join career_sources cs on cs.company_id = s.company_id
          join scans sc on sc.source_id = cs.id and sc.scan_run_id = ${run.id}::uuid
          where s.user_id = u.id and s.status = 'active')
        and not exists (select 1 from settings st where st.key = 'internal:suggestFromScans:' || u.id::text
          and (st.value->>'at')::timestamptz > ${minedSince})
      on conflict do nothing`);
    log.info("scan run finalised", { runId: run.id, ok: companiesOk, failed: Math.max(0, run.companiesTotal - companiesOk), newRoles: summary.new_roles });
  }
  return finalised;
}

export async function companiesWithoutSources(deps: WorkerDeps): Promise<string[]> {
  const rows = await deps.db.execute<{ id: string }>(sql`
    select c.id from companies c
    left join career_sources cs on cs.company_id = c.id and cs.status in ('active','failing')
    where c.status = 'active' and cs.id is null`);
  return rows.rows.map((r) => r.id);
}

export { inArray as _inArray };
