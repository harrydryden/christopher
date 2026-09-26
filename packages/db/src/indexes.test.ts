/**
 * The query shapes the indexes of migration 0036 exist for, each shown to be servable by its index.
 * Sequential scans are switched off, so a plan names an index whenever one can answer the query;
 * what these prove is that the index exists and that the planner can use it, partial predicates
 * included, not how it would choose on production statistics.
 *
 * Requires a database: set TEST_DATABASE_URL (defaults to the local ava_test database).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { createDb } from "./client";
import { runMigrations } from "./migrate";

const { db, pool } = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test", { max: 1 });
beforeAll(() => runMigrations(db));
afterAll(() => pool.end());

/**
 * The plan for `query` with sequential scans off and every other index on `index`'s table dropped,
 * inside a transaction that is rolled back. That takes the planner's statistics out of it: the
 * question is whether this index can answer the query, not which of two a given table's numbers
 * happen to favour today.
 */
async function plan(query: SQL, index: string): Promise<string> {
  let text = "";
  await db.transaction(async tx => {
    const others = await tx.execute<{ name: string }>(sql`
      select i.indexname as name from pg_indexes i
      where i.schemaname = 'public' and i.indexname <> ${index}
        and i.tablename = (select tablename from pg_indexes where schemaname = 'public' and indexname = ${index})
        and not exists (select 1 from pg_constraint c where c.conindid = (quote_ident(i.indexname))::regclass)`);
    for (const { name } of others.rows) await tx.execute(sql`drop index ${sql.identifier(name)}`);
    await tx.execute(sql`set local enable_seqscan = off`);
    const rows = await tx.execute(sql`explain ${query}`);
    text = rows.rows.map(row => Object.values(row).join(" ")).join("\n");
    tx.rollback();
  }).catch(error => {
    if (!text) throw error;
  });
  return text;
}

const id = randomUUID();
const other = randomUUID();

/** A join is planned in whichever order an empty table's numbers favour, so for these only the index's use is asserted. */
type Case = [name: string, query: SQL, index: string, joined?: "joined"];

const cases: Case[] = [
  // Deleting a posting or a draft: the referential actions look rows up by the referencing column.
  ["decisions by posting", sql`select 1 from decisions where job_id = ${id}`, "decisions_job_idx"],
  ["drafts by posting", sql`select 1 from cv_drafts where job_id = ${id}`, "cv_drafts_job_user_idx"],
  ["an account's CV for a role", sql`select 1 from cv_drafts c where c.user_id = ${id} and c.job_id = ${other} and c.archived_at is null`, "cv_drafts_job_user_idx"],
  ["applications by posting", sql`select 1 from applications where job_id = ${id}`, "applications_job_idx"],
  ["applications by draft", sql`select 1 from applications where cv_id = ${id}`, "applications_cv_idx"],
  ["share links by draft", sql`select 1 from cv_shares where draft_id = ${id}`, "cv_shares_draft_idx"],
  ["postings an account pasted", sql`select 1 from jobs where added_by = ${id}`, "jobs_added_by_idx"],
  ["an account's discovery candidates", sql`select 1 from discovery_candidates where user_id = ${id}`, "discovery_candidates_user_idx"],
  ["an account's job events", sql`select 1 from job_events where user_id = ${id}`, "job_events_user_job_at_idx"],
  // A posting's recent events, one half each.
  ["a posting's shared events", sql`select id from job_events where job_id = ${id} and user_id is null order by at desc limit 6`, "job_events_shared_job_at_idx"],
  ["a posting's events for one account", sql`select id from job_events where user_id = ${other} and job_id = ${id} order by at desc limit 6`, "job_events_user_job_at_idx"],
  // Tasks by what their payload is about.
  ["a company's last scan", sql`select finished_at from tasks where type = 'scan_company' and status = 'done' and payload->>'companyId' = ${id} order by coalesce(finished_at, created_at) desc limit 1`, "tasks_company_idx"],
  ["a company's pending discovery", sql`select 1 from tasks where type in ('scan_company', 'discover') and status in ('queued', 'running') and payload->>'companyId' in (${id}, ${other})`, "tasks_company_idx"],
  ["a draft's build task", sql`select t.status from tasks t inner join cv_drafts d on t.payload->>'draftId' = d.id::text where t.type = 'generate_cv' and d.user_id = ${id} and d.id = ${other} order by t.created_at desc limit 1`, "tasks_draft_idx", "joined"],
  ["an account's builds in flight", sql`select d.id, t.status from cv_drafts d left join tasks t on t.type = 'generate_cv' and t.payload->>'draftId' = d.id::text where d.user_id = ${id} and d.status in ('queued', 'generating')`, "tasks_draft_idx", "joined"],
  ["a draft's live build", sql`select 1 from tasks t where t.type = 'generate_cv' and t.payload->>'draftId' = ${id} and t.status in ('queued', 'running')`, "tasks_draft_idx"],
  ["an account's last library review", sql`select * from tasks where type = 'review_library' and payload->>'userId' = ${id} order by created_at desc limit 1`, "tasks_user_idx"],
  // The claim's fairness: how many CV builds one account already has running (0041).
  ["an account's running CV builds", sql`select count(*) from tasks r where r.type = 'generate_cv' and r.status = 'running' and r.payload->>'userId' = ${id}`, "tasks_cv_running_user_idx"],
  // The scan banner, Health and the suggestion sweep.
  ["roles first seen in one scan", sql`select 1 from jobs where source_id = ${id} and first_seen_at >= now() - interval '1 hour' and first_seen_at <= now()`, "jobs_source_first_seen_idx"],
  // The status strip's last completed scan, one source at a time (0042).
  ["a source's last completed scan", sql`select max(finished_at) from scans where source_id = ${id} and finished_at is not null and status <> 'failed'`, "scans_source_completed_idx"],
  ["recent problem scans", sql`select 1 from scans where status <> 'ok' and started_at >= now() - interval '7 days'`, "scans_started_idx"],
  ["the suggestion expiry", sql`update company_suggestions set status = 'expired' where status = 'pending' and created_at < now() - interval '30 days'`, "company_suggestions_pending_created_idx"],
  ["the failed-task list", sql`select * from tasks where status = 'failed' order by finished_at desc limit 50`, "tasks_status_finished_idx"],
  // Retention, statement by statement.
  ["finished tasks", sql`select id from tasks where status in ('done', 'failed') and finished_at < now() - interval '30 days' limit 5000`, "tasks_status_finished_idx"],
  ["transient job events", sql`select id from job_events where type in ('updated', 'scored', 'description_fetched') and at < now() - interval '90 days' limit 5000`, "job_events_prunable_at_idx"],
  ["old scans", sql`select id from scans where started_at < now() - interval '90 days' limit 5000`, "scans_started_idx"],
  ["read discovery documents", sql`select id from discovery_documents where processed_at < now() - interval '90 days' and content <> '' limit 5000`, "discovery_documents_processed_idx"],
  ["expired verifications", sql`select key from verification_cache where expires_at < now() limit 5000`, "verification_cache_expires_idx"],
  ["login attempts", sql`select id from login_attempts where at < now() - interval '1 day' limit 5000`, "login_attempts_at_idx"],
  ["expired sessions", sql`select id from sessions where expires_at < now() limit 5000`, "sessions_expires_idx"],
  ["expired links", sql`select id from auth_tokens where expires_at < now() - interval '1 day' limit 5000`, "auth_tokens_expires_idx"],
  ["spent links", sql`select id from auth_tokens where used_at < now() - interval '1 day' limit 5000`, "auth_tokens_used_idx"],
  ["expired AI holds", sql`select id from ai_reservations where expires_at < now() - interval '1 hour' limit 5000`, "ai_reservations_expires_idx"],
  ["old discovery runs", sql`select id from discovery_runs where started_at < now() - interval '90 days' limit 5000`, "discovery_runs_started_idx"],
];

describe("migration 0036's indexes", () => {
  it.each(cases)("serve %s", async (_name, query, index, joined) => {
    const text = await plan(query, index);
    // Used with conditions, not read end to end: the node names the index and carries an Index Cond.
    if (joined) expect(text).toMatch(new RegExp(`using ${index} `));
    else expect(text).toMatch(new RegExp(`(using|on) ${index} [^\\n]*\\n\\s+Index Cond:`));
  });
});
