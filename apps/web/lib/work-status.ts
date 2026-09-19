import { and, inArray, sql } from 'drizzle-orm';
import { tasks } from '@christopher/db/schema';
import { cache } from 'react';
import { db } from './db';
/** Once per request, however many components ask. Only work that can change this account's view counts. */
export const getCompanyWorkStatus = cache(async function getCompanyWorkStatus(userId: string) {
  const [row] = await db().select({ n: sql<number>`count(*)::int`, version: sql<string>`md5(coalesce(string_agg(${tasks.id}::text || ${tasks.status}, ',' order by ${tasks.id}), ''))` })
    .from(tasks).where(and(
      inArray(tasks.type, ['discover', 'scan_company', 'run_daily', 'reevaluate_gate', 'import_posting']),
      inArray(tasks.status, ['queued', 'running']),
      // An import is one account's: another follower's paste must not spin this one's page.
      sql`(${tasks.type} = 'run_daily'
        or (${tasks.type} = 'reevaluate_gate' and coalesce(${tasks.payload}->>'userId', ${userId}) = ${userId})
        or (${tasks.type} = 'import_posting' and ${tasks.payload}->>'userId' = ${userId})
        or (${tasks.type} <> 'import_posting'
            and exists (select 1 from company_subscriptions s where s.user_id = ${userId} and s.company_id::text = ${tasks.payload}->>'companyId')))`,
    ));
  return { active: (row?.n ?? 0) > 0, version: row?.version ?? "" };
});
