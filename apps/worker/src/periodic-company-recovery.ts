import { enqueueStandard, companiesDueLogoCapture, type Db } from "@col/db";
import { sql } from "drizzle-orm";

/** Bound catalogue recovery so a restart or several workers cannot flood external sites. */
export const DISCOVERY_RECOVERY_BATCH = 25;
export const LOGO_SWEEP_BATCH = 10;
export const LOGO_SWEEP_DAILY_CAP = 200;

export async function sweepDueDiscoveryRecovery(db: Db, now: Date, limit = DISCOVERY_RECOVERY_BATCH): Promise<number> {
  return db.transaction(async tx => {
    const due = await tx.execute<{ id: string; homepageUrl: string }>(sql`select c.id, c.homepage_url as "homepageUrl" from companies c
      where c.status = 'active' and c.discovery_recovery_state = 'waiting'
        and c.discovery_next_attempt_at <= ${now}
        and exists (select 1 from company_subscriptions s where s.company_id = c.id and s.status = 'active')
        and not exists (select 1 from career_sources cs where cs.company_id = c.id)
        and not exists (select 1 from tasks t where t.type = 'discover' and t.status in ('queued', 'running')
          and t.payload->>'companyId' = c.id::text and coalesce(t.payload->>'logoOnly', 'false') <> 'true')
      order by c.discovery_next_attempt_at, c.id
      limit ${limit} for update of c skip locked`);
    let queued = 0;
    for (const company of due.rows) {
      const id = await enqueueStandard(tx as unknown as Db, "discover", { companyId: company.id, homepageUrl: company.homepageUrl, reason: "recovery" }, { priority: 6 });
      if (!id) continue;
      await tx.execute(sql`update companies set discovery_recovery_attempts = discovery_recovery_attempts + 1,
        discovery_recovery_state = 'idle', discovery_next_attempt_at = null where id = ${company.id}::uuid`);
      queued++;
    }
    return queued;
  });
}

/** Five-minute sweep, with a UTC-day cap recorded by the tasks it actually inserted. */
export async function sweepDueCompanyLogos(db: Db, now: Date): Promise<number> {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ava:logo-sweep'))`);
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const end = new Date(start.getTime() + 86_400_000);
    const [used] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from tasks t
      where t.type = 'discover' and t.payload->>'reason' = 'logo_sweep'
        and t.created_at >= ${start} and t.created_at < ${end}`).then(r => r.rows);
    const limit = Math.min(LOGO_SWEEP_BATCH, Math.max(0, LOGO_SWEEP_DAILY_CAP - (used?.n ?? 0)));
    if (!limit) return 0;
    const due = await companiesDueLogoCapture(tx as unknown as Db, now, limit);
    let queued = 0;
    for (const company of due) {
      const id = await enqueueStandard(tx as unknown as Db, "discover", {
        companyId: company.id, logoOnly: true, homepageUrl: company.homepageUrl, reason: "logo_sweep",
      }, { priority: 6 });
      if (id) queued++;
    }
    return queued;
  });
}
