-- Preserve existing retained roles and decisions when switching to the four-status workflow.
with archived as (
  update jobs j set archived_at = now(), updated_at = now()
  where j.in_table = false and j.archived_at is null
  and not exists (select 1 from decisions d where d.job_id = j.id and d.superseded = false)
  returning j.id
)
insert into job_events (job_id, type, payload)
select id, 'updated', '{"action":"archived","actor":"system","reason":"No longer matches your criteria"}'::jsonb from archived;
--> statement-breakpoint
update jobs set hidden = false where hidden = true;
