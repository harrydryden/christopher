import { sql, type SQLWrapper } from "drizzle-orm";

/**
 * One canonical, collision-free expression shared by lookup, locking and the index.
 * Scoped by user: two people can each keep a CV for the same company and title.
 */
export function cvRoleKey(
  userId: string | SQLWrapper,
  company: string | SQLWrapper,
  title: string | SQLWrapper,
) {
  const normalise = (value: string | SQLWrapper) =>
    sql`lower(btrim(regexp_replace(${value}, '[[:space:]]+', ' ', 'g')))`;
  const name = normalise(company);
  return sql<string>`(${userId}::text || ':' || length(${name})::text || ':' || ${name} || ${normalise(title)})`;
}
