import { MAX_FOLLOWED_COMPANIES } from "@ava/core";
import type { User } from "@ava/db/schema";
import { sql } from "drizzle-orm";
import { UserFacingError } from "./validation";

type Executor = { execute: (query: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> };

/**
 * Refuse a change that would leave a member following more than `MAX_FOLLOWED_COMPANIES` companies,
 * active or paused (an archived follow starts no work). `domains` and `companyIds` name what the
 * change follows; the ones the account already follows are not counted twice. The account's follow
 * lock is taken first and held to the end of the caller's transaction, so two submissions from one
 * account cannot both pass the same count. Administrators are not limited.
 */
export async function assertFollowCapacity(tx: Executor, user: Pick<User, "id" | "role">, targets: { domains?: string[]; companyIds?: string[] }): Promise<void> {
  const domains = [...new Set(targets.domains ?? [])];
  const companyIds = [...new Set(targets.companyIds ?? [])];
  if (user.role === "admin" || domains.length + companyIds.length === 0) return;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`follow:${user.id}`}))`);
  const named = sql.join([
    ...(domains.length ? [sql`c.domain in (${sql.join(domains.map(domain => sql`${domain}`), sql`, `)})`] : []),
    ...(companyIds.length ? [sql`c.id in (${sql.join(companyIds.map(id => sql`${id}::uuid`), sql`, `)})`] : []),
  ], sql` or `);
  const result = await tx.execute(sql`select count(*)::int as following, count(*) filter (where ${named})::int as already
    from company_subscriptions s join companies c on c.id = s.company_id
    where s.user_id = ${user.id}::uuid and s.status in ('active', 'paused')`);
  const [row] = result.rows as Array<{ following: number; already: number }>;
  const following = Number(row?.following ?? 0);
  const adding = domains.length + companyIds.length - Number(row?.already ?? 0);
  if (adding > 0 && following + adding > MAX_FOLLOWED_COMPANIES) {
    throw new UserFacingError(`An account can follow up to ${MAX_FOLLOWED_COMPANIES} companies, and you follow ${following}. Archive the ones you no longer need, then add ${adding === 1 ? "this one" : "these"}.`);
  }
}
