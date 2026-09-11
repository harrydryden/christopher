import { sql } from "drizzle-orm";
import { jobs, decisions } from "./schema";
import type { RoleStatus } from "@christopher/core";
/** Requires the active-decision LEFT JOIN. Shared by tables, totals and exports. */
export const roleStatusSql = sql<RoleStatus>`case
  when ${jobs.archivedAt} is not null then 'archived'
  when ${decisions.decision} = 'apply' then 'user-shortlisted'
  when ${decisions.decision} = 'skip' then 'user-dismissed'
  when ${jobs.inTable} then 'auto-matched'
  else 'archived' end`;
