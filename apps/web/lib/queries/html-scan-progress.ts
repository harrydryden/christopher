import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ifMigrated } from "@/lib/schema-skew";
import { cache } from "react";

/** One unfinished, durable listing read for a company this account actively follows. */
export interface HtmlScanProgress {
  generationId: string;
  companyId: string;
  companyName: string;
  sourceId: string;
  sourceUrl: string;
  pagesRead: number;
  /** Pages whose positive role observations have been reconciled; they may contain no matches. */
  publishedPages: number;
  stagedPostings: number;
  startedAt: Date;
  expiresAt: Date;
  taskStatus: "queued" | "running" | "done" | "failed";
  runAfter: Date;
  taskError: string | null;
}

export function interruptedHtmlRead(item: HtmlScanProgress, now: Date): boolean {
  return item.taskStatus === "failed" || item.taskStatus === "done" || item.expiresAt <= now;
}

type RawProgress = Omit<HtmlScanProgress, "pagesRead" | "publishedPages" | "stagedPostings"> & {
  pagesRead: number | string;
  publishedPages: number | string;
  stagedPostings: number | string;
};

/**
 * An unfinished read may have already made verified matches available. The latest generation is
 * the only one worth showing for a source. A later complete scan clears it; a newer queued or running
 * company scan supersedes an abandoned task even before its first page is saved. Both tests
 * matter because an interrupted task can leave its generation until retention cleans it up.
 */
export const listHtmlScanProgress = cache(async (userId: string): Promise<HtmlScanProgress[]> => {
  return ifMigrated(async () => {
    const result = await db().execute<RawProgress>(sql`
      with latest as (
        select g.*, row_number() over (partition by g.source_id order by g.started_at desc, g.id desc) as source_rank
        from html_scan_generations g
      )
      select g.id as "generationId", c.id as "companyId", c.name as "companyName",
        s.id as "sourceId", s.url as "sourceUrl",
        p."pagesRead", g.published_page_count as "publishedPages", p."stagedPostings", g.started_at as "startedAt",
        g.expires_at as "expiresAt", t.status as "taskStatus", t.run_after as "runAfter",
        t.error as "taskError"
      from latest g
      join career_sources s on s.id = g.source_id
      join companies c on c.id = s.company_id
      join company_subscriptions cs on cs.company_id = c.id and cs.user_id = ${userId} and cs.status = 'active'
      join tasks t on t.id = g.task_id
      cross join lateral (
        select count(*)::int as "pagesRead",
          coalesce(sum(jsonb_array_length(page.postings)), 0)::int as "stagedPostings"
        from html_scan_pages page where page.generation_id = g.id
      ) p
      where g.source_rank = 1 and c.status = 'active' and s.status in ('active', 'failing')
        and not exists (
          select 1 from scans completed
          where completed.source_id = s.id and completed.status = 'ok'
            and completed.finished_at > g.started_at
        )
        and not exists (
          select 1 from tasks newer
          where newer.type = 'scan_company' and newer.status in ('queued', 'running')
            and newer.created_at > t.created_at
            and newer.payload->>'companyId' = c.id::text
            and (newer.payload->'sourceIds' is null or newer.payload->'sourceIds' ? s.id::text)
        )
      order by case when t.status in ('failed', 'done') or g.expires_at <= now() then 0 else 1 end,
        g.started_at desc, g.id desc
      limit 100`);
    return result.rows.map(row => ({
      ...row,
      pagesRead: Number(row.pagesRead),
      publishedPages: Number(row.publishedPages),
      stagedPostings: Number(row.stagedPostings),
      startedAt: new Date(row.startedAt),
      expiresAt: new Date(row.expiresAt),
      runAfter: new Date(row.runAfter),
    }));
  }, () => []);
});
