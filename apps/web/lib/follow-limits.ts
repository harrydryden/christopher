import type { User } from "@col/db/schema";
import { sql } from "drizzle-orm";
import { assertCanActivateCompanies } from "./billing/service";

type Executor = NonNullable<Parameters<typeof assertCanActivateCompanies>[2]>;

export async function lockCompanyFollows(tx: Executor, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`follow:${userId}`}))`);
}

/**
 * Check only newly active follows against the plan allowance. Paused and archived companies use
 * no monitoring capacity. `domains` and `companyIds` name what the change follows; already-active
 * companies are not counted twice. The account's follow
 * lock is taken first and held to the end of the caller's transaction, so two submissions from one
 * account cannot both pass the same count. Purchasing extra capacity is a separate Account action.
 */
export async function assertFollowCapacity(tx: Executor, user: Pick<User, "id" | "role">, targets: { domains?: string[]; companyIds?: string[] }): Promise<void> {
  const domains = [...new Set(targets.domains ?? [])];
  const companyIds = [...new Set(targets.companyIds ?? [])];
  if (domains.length + companyIds.length === 0) return;
  await lockCompanyFollows(tx, user.id);
  const named = sql.join([
    ...(domains.length ? [sql`c.domain in (${sql.join(domains.map(domain => sql`${domain}`), sql`, `)})`] : []),
    ...(companyIds.length ? [sql`c.id in (${sql.join(companyIds.map(id => sql`${id}::uuid`), sql`, `)})`] : []),
  ], sql` or `);
  const result = await tx.execute(sql`select count(*) filter (where ${named})::int as already
    from company_subscriptions s join companies c on c.id = s.company_id
    where s.user_id = ${user.id}::uuid and s.status = 'active'`);
  const [row] = result.rows as Array<{ already: number }>;
  const adding = domains.length + companyIds.length - Number(row?.already ?? 0);
  if (adding > 0) await assertCanActivateCompanies(user.id, adding, tx);
}
