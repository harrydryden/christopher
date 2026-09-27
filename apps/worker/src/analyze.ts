/**
 * Fresh planner statistics after a bulk write.
 *
 * Autovacuum analyses a table once enough of it has changed, which on a table that has just
 * doubled can be hours away; until then the planner prices the new rows as if they were not there
 * and picks nested loops for joins that now return thousands of rows. After the two bulk writes
 * the worker makes — adding many companies at once, and a gate re-evaluation that rewrites
 * hundreds of an account's views — it analyses the tables they changed itself.
 *
 * Never inside a request or a task's own transaction: ANALYZE takes a lock that conflicts with
 * another ANALYZE or VACUUM of the same table, and a statistics refresh must not hold a write up.
 * A failure is logged and ignored; stale statistics are a slow plan, not a wrong answer.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@ava/db";
import { log } from "./log";

/** A gate re-evaluation that writes more than this many of an account's views is a bulk write. */
export const GATE_ANALYZE_THRESHOLD = 500;
/** Adding more than this many companies in one go is a bulk import. */
export const IMPORT_ANALYZE_THRESHOLD = 50;

/** The tables a company import grows, in the order a follower's reads join them. */
export const IMPORT_TABLES = ["companies", "career_sources", "company_subscriptions", "user_jobs"] as const;
/** The table a gate re-evaluation rewrites. */
export const GATE_TABLES = ["user_jobs"] as const;

const ANALYZABLE = new Set<string>([...IMPORT_TABLES, ...GATE_TABLES]);

export async function analyzeTables(db: Pick<Db, "execute">, tables: readonly string[], reason: string): Promise<boolean> {
  const names = tables.filter(table => ANALYZABLE.has(table));
  if (!names.length) return false;
  const started = Date.now();
  try {
    await db.execute(sql.raw(`analyze ${names.map(name => `"${name}"`).join(", ")}`));
    log.info("analysed tables after a bulk write", { tables: names, reason, ms: Date.now() - started });
    return true;
  } catch (error) {
    log.warn("analyse after a bulk write failed", { tables: names, reason, error: (error as Error).message });
    return false;
  }
}
