import { sql } from "drizzle-orm";
import { userJobs, decisions } from "./schema";
import type { RoleStatus } from "@christopher/core";
/** Requires the `user_jobs` row and the active-decision LEFT JOIN. Shared by tables, totals and exports. */
export const roleStatusSql = sql<RoleStatus>`case
  when ${userJobs.archivedAt} is not null then 'archived'
  when ${decisions.decision} = 'apply' then 'user-shortlisted'
  when ${decisions.decision} = 'skip' then 'user-dismissed'
  when ${userJobs.inTable} then 'auto-matched'
  else 'archived' end`;
