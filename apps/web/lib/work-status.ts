import { and, inArray, sql } from 'drizzle-orm';
import { tasks } from '@christopher/db/schema';
import { db } from './db';
export async function getCompanyWorkStatus() {
  const [row] = await db().select({ n: sql<number>`count(*)::int`, version: sql<string>`md5(coalesce(string_agg(${tasks.id}::text || ${tasks.status}, ',' order by ${tasks.id}), ''))` })
    .from(tasks).where(and(inArray(tasks.type, ['discover', 'scan_company', 'run_daily', 'reevaluate_gate']), inArray(tasks.status, ['queued', 'running'])));
  return { active: (row?.n ?? 0) > 0, version: row?.version ?? "" };
}
