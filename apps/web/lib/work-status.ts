import { and, inArray } from 'drizzle-orm';
import { tasks } from '@christopher/db/schema';
import { db } from './db';
export async function getCompanyWorkStatus() {
  const rows = await db().select({ id: tasks.id, status: tasks.status }).from(tasks).where(and(inArray(tasks.type, ['discover', 'scan_company', 'run_daily']), inArray(tasks.status, ['queued', 'running']))).orderBy(tasks.id);
  return { active: rows.length > 0, version: JSON.stringify(rows) };
}
