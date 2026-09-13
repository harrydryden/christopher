import { sql, type SQLWrapper } from "drizzle-orm";

/** One canonical, collision-free expression shared by lookup, locking and the index. */
export function cvRoleKey(
  company: string | SQLWrapper,
  title: string | SQLWrapper,
) {
  const normalise = (value: string | SQLWrapper) =>
    sql`lower(btrim(regexp_replace(${value}, '[[:space:]]+', ' ', 'g')))`;
  const name = normalise(company);
  return sql<string>`(length(${name})::text || ':' || ${name} || ${normalise(title)})`;
}
