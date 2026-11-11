import { sql } from "drizzle-orm";
import { CATALOGUE_FRESH_DAYS, careerMatchTerms, rankCatalogueRoles, type CareerRecommendationProfile, type CatalogueRoleCandidate } from "@col/core/catalogue-recommendations";
import type { GateSettings } from "@col/core";
import type { Db } from "./client";

/** Matches migration 0072's partial search index exactly. */
const searchVector = sql`to_tsvector('simple', coalesce(j.title, '') || ' ' || coalesce(j.department, '') || ' ' || coalesce(j.description_text, ''))`;

/**
 * Shared catalogue discovery does not depend on a subscription or user_jobs row. Retrieval is
 * indexed and bounded before the richer gate is evaluated in core; no career text leaves our DB.
 * Negative feedback is account-scoped, and private/manual postings cannot become candidates.
 */
export async function recommendCatalogueRoles(db: Db, userId: string, profile: CareerRecommendationProfile, gate: GateSettings, now = new Date()) {
  const terms = careerMatchTerms(profile).filter(term => term.kind !== "industry");
  if (!terms.length) return [];
  const query = sql.join(terms.map(term => sql`plainto_tsquery('simple', ${term.label})`), sql` || `);
  const freshAfter = new Date(now.getTime() - CATALOGUE_FRESH_DAYS * 86_400_000);
  const candidates: CatalogueRoleCandidate[] = [];
  // Filter after each bounded page, continuing past dense off-location results. This is a
  // recommendation sample, not exhaustive search; stop once there is a useful varied shortlist.
  for (let offset = 0; offset < 5000; offset += 500) {
    const rows = await db.execute<CatalogueRoleCandidate & Record<string, unknown>>(sql`
    select j.id, j.company_id as "companyId", c.name as "companyName", c.domain,
      c.homepage_url as "homepageUrl", j.url, j.title, j.department,
      left(j.description_text, 30000) as description,
      j.location, j.locations, j.remote, j.location_resolution as "locationResolution",
      j.last_seen_at as "lastSeenAt", j.status, j.shared, j.manual_owner_id as "manualOwnerId",
      coalesce(p.sector, '') || ' ' || coalesce(p.sub_sector, '') || ' ' || coalesce(p.tags::text, '') as "companyText",
      exists(select 1 from company_subscriptions s where s.user_id = ${userId}::uuid and s.company_id = c.id and s.status in ('active', 'paused')) as following
    from jobs j join companies c on c.id = j.company_id
    left join lateral (select sector, sub_sector, tags from company_profiles where company_id = c.id order by generated_at desc, id desc limit 1) p on true
    where j.shared = true and j.manual_owner_id is null and j.status = 'open'
      and j.last_seen_at >= ${freshAfter}
      and ${searchVector} @@ (${query})
      and not exists(select 1 from company_suggestions s where s.user_id = ${userId}::uuid and s.domain = c.domain and s.status = 'rejected')
      and not exists(select 1 from company_subscriptions s where s.user_id = ${userId}::uuid and s.company_id = c.id and s.status = 'archived')
      and not exists(select 1 from user_jobs u where u.user_id = ${userId}::uuid and u.job_id = j.id and (u.hidden or u.archived_at is not null))
      and not exists(select 1 from decisions d where d.user_id = ${userId}::uuid and d.job_id = j.id and d.superseded = false)
    order by ts_rank(${searchVector}, (${query})) desc, j.last_seen_at desc, j.id
    limit 500 offset ${offset}`);
    candidates.push(...rankCatalogueRoles(profile, rows.rows.map(row => ({ ...row, lastSeenAt: new Date(row.lastSeenAt) })), gate, now).map(match => match.role));
    if (rows.rows.length < 500 || (candidates.length >= 12 && new Set(candidates.map(role => role.companyId)).size >= 6)) return rankCatalogueRoles(profile, candidates, gate, now);
  }
  return rankCatalogueRoles(profile, candidates, gate, now);
}
