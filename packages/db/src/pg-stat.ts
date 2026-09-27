import { sql } from "drizzle-orm";
import type { Db } from "./client";

/**
 * One statement's totals from `pg_stat_statements`, as the CLI's `pgstat` and the Operations card
 * show them. `query` is normalised by PostgreSQL (literals become `$1`) and then cut to 160
 * characters, with runs of whitespace folded; it is shown to an administrator and written nowhere.
 */
export interface StatementTotal {
  queryid: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  stddevMs: number;
  rows: number;
  sharedBlksHit: number;
  sharedBlksRead: number;
  /** Buffer hits as a share of all buffer reads, in percent; null when the statement read none. */
  hitPct: number | null;
  query: string;
}

export type StatementTotals =
  | { available: true; rows: StatementTotal[] }
  | { available: false; reason: string };

const NOT_INSTALLED = "42P01";
const NOT_LOADED = "55000";
const NO_FUNCTION = "42883";

function code(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const value = (current as { code?: unknown }).code;
    if (typeof value === "string") return value;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Why the statistics cannot be read, in the words an operator acts on, or null for any other error. */
function unavailable(error: unknown): string | null {
  switch (code(error)) {
    case NOT_INSTALLED:
    case NO_FUNCTION:
      return "pg_stat_statements is not installed in this database: migration 0045 skipped it, most likely for want of privilege. Create it as the database owner.";
    case NOT_LOADED:
      return "pg_stat_statements is installed but not loaded: the server's shared_preload_libraries does not include it, so it has recorded nothing.";
    default:
      return null;
  }
}

/**
 * The twenty statements that have cost this database the most execution time since the statistics
 * were last reset. Only this database's rows (`dbid`), so a shared cluster's other tenants are not
 * read. A database without the extension, or a server that has not preloaded it, answers
 * `available: false` with the reason rather than throwing; any other error throws.
 */
export async function topStatements(db: Db, limit = 20): Promise<StatementTotals> {
  try {
    const result = await db.execute<{
      queryid: string; calls: string | number; total_ms: string | number; mean_ms: string | number; sd_ms: string | number;
      rows: string | number; shared_blks_hit: string | number; shared_blks_read: string | number; hit_pct: string | number | null; query: string;
    }>(sql`select queryid::text as queryid, calls, round(total_exec_time::numeric, 1) as total_ms,
        round(mean_exec_time::numeric, 2) as mean_ms, round(stddev_exec_time::numeric, 2) as sd_ms,
        rows, shared_blks_hit, shared_blks_read,
        round(100.0 * shared_blks_hit / nullif(shared_blks_hit + shared_blks_read, 0), 1) as hit_pct,
        left(regexp_replace(query, '\\s+', ' ', 'g'), 160) as query
      from pg_stat_statements
      where dbid = (select oid from pg_database where datname = current_database())
      order by total_exec_time desc
      limit ${Math.max(1, Math.min(100, Math.trunc(limit)))}`);
    return {
      available: true,
      rows: result.rows.map((row) => ({
        queryid: row.queryid,
        calls: Number(row.calls),
        totalMs: Number(row.total_ms),
        meanMs: Number(row.mean_ms),
        stddevMs: Number(row.sd_ms),
        rows: Number(row.rows),
        sharedBlksHit: Number(row.shared_blks_hit),
        sharedBlksRead: Number(row.shared_blks_read),
        hitPct: row.hit_pct === null ? null : Number(row.hit_pct),
        query: row.query ?? "",
      })),
    };
  } catch (error) {
    const reason = unavailable(error);
    if (reason) return { available: false, reason };
    throw error;
  }
}

/**
 * The CLI's table: one line per statement, the figures right-aligned and the query text last, as
 * the reader already truncated it.
 */
export function formatStatementTotals(rows: StatementTotal[]): string[] {
  const head = ["calls", "total ms", "mean ms", "sd ms", "rows", "hit", "read", "hit %", "query"];
  const body = rows.map((row) => [
    String(row.calls), row.totalMs.toFixed(1), row.meanMs.toFixed(2), row.stddevMs.toFixed(2), String(row.rows),
    String(row.sharedBlksHit), String(row.sharedBlksRead), row.hitPct === null ? "–" : row.hitPct.toFixed(1), row.query,
  ]);
  const widths = head.slice(0, -1).map((title, i) => Math.max(title.length, ...body.map((cells) => cells[i]!.length)));
  const line = (cells: string[]) => [...cells.slice(0, -1).map((cell, i) => cell.padStart(widths[i]!)), cells.at(-1)!].join("  ");
  return [line(head), ...body.map(line)];
}

/**
 * Start the statistics afresh, so the next reading covers a known window. Needs the extension
 * loaded and the privilege to reset it (superuser or a grant on the function); either missing
 * answers `ok: false` with the reason.
 */
export async function resetStatements(db: Db): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await db.execute(sql`select pg_stat_statements_reset()`);
    return { ok: true };
  } catch (error) {
    const reason = unavailable(error) ?? (code(error) === "42501" ? "This role may not reset pg_stat_statements; ask the database owner to grant execute on pg_stat_statements_reset()." : null);
    if (reason) return { ok: false, reason };
    throw error;
  }
}
