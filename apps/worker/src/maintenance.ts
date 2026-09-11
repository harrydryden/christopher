import { sql } from "drizzle-orm";
import type { WorkerDeps } from "./context";

/** Bounded hourly cleanup. Keep fingerprints, decisions, applications and review evidence. */
export async function maintainHistory(deps: WorkerDeps) {
  await deps.db.transaction(async tx => {
    const claimed = await tx.execute(sql`insert into settings (key,value,updated_at) values ('internal:lastMaintenance','{}',now())
      on conflict (key) do update set updated_at=now() where settings.updated_at < now() - interval '1 hour' returning key`);
    if (!claimed.rows.length) return;
    await tx.execute(sql`delete from tasks where id in (select id from tasks where status in ('done','failed') and finished_at < now() - interval '30 days' limit 1000)`);
    await tx.execute(sql`update discovery_documents set content='' where id in (select d.id from discovery_documents d
      where d.processed_at < now() - interval '90 days' and d.content <> '' and not exists
      (select 1 from discovery_candidates c where c.document_id=d.id and c.processed_at is null) limit 1000)`);
    await tx.execute(sql`delete from scans where id in (select s.id from scans s where s.started_at < now() - interval '90 days'
      and not exists (select 1 from (select id from scans recent where recent.source_id=s.source_id order by started_at desc limit 3) keep where keep.id=s.id)
      and not exists (select 1 from (select id from scans recent where recent.source_id=s.source_id and status='ok' order by started_at desc limit 1) keep where keep.id=s.id) limit 1000)`);
    await tx.execute(sql`delete from job_events where id in (select id from job_events where type in ('updated','scored','description_fetched') and at < now() - interval '90 days' limit 1000)`);
    await tx.execute(sql`delete from verification_cache where key in (select key from verification_cache where expires_at < now() limit 1000)`);
    await tx.execute(sql`delete from host_pacing where next_at < now() - interval '7 days'`);
  });
}
