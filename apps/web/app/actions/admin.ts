"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { retireSourceRoles } from "@ava/db";
import { careerSources, companies, companyNameSuggestions } from "@ava/db/schema";
import { ensureHttpUrl, extractDomain } from "@ava/core";
import { requireAdmin } from "@/lib/auth";
import { applySuggestedName, normaliseCompanyName } from "@/lib/company-names";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
import { fail, zUuid, type ActionResult } from "@/lib/validation";
import { unsafeUrlRefusal } from "@/lib/public-url";

/** Catalogue edits are seen by every follower, so they live in the administrator's section. */
function revalidateCatalogue(companyId?: string | null): void {
  revalidatePath("/admin/catalogue");
  revalidatePath("/companies");
  revalidatePath("/");
  if (companyId) revalidatePath(`/companies/${companyId}`);
}

/** Rename a shared company or correct its main website; a new website re-fetches the logo. */
export async function saveCatalogueCompany(companyId: string, _previous: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireAdmin();
  const id = zUuid().parse(companyId);
  const [current] = await db().select({ homepageUrl: companies.homepageUrl, name: companies.name }).from(companies).where(eq(companies.id, id)).limit(1);
  if (!current) return fail("Company not found.");
  const name = normaliseCompanyName(String(formData.get("name") ?? ""));
  const rawHomepage = String(formData.get("homepageUrl") ?? "").trim();
  let homepageUrl: string;
  try {
    if (!rawHomepage || rawHomepage.length > 2048 || (/^[a-z][a-z0-9+.-]*:/i.test(rawHomepage) && !/^https?:\/\//i.test(rawHomepage))) throw new Error();
    homepageUrl = ensureHttpUrl(rawHomepage);
    const parsed = new URL(homepageUrl);
    if (parsed.username || parsed.password || !parsed.hostname.includes(".")) throw new Error();
  } catch {
    return fail("Enter a valid main website, such as https://anduril.com/.");
  }
  // The worker fetches the homepage for the logo and for discovery, so it must be one it may fetch.
  const unsafe = unsafeUrlRefusal(homepageUrl);
  if (unsafe) return fail(unsafe);
  const domain = extractDomain(homepageUrl);
  const duplicate = await db().select({ id: companies.id }).from(companies).where(eq(companies.domain, domain)).limit(1);
  if (duplicate[0] && duplicate[0].id !== id) return fail("Another company already uses this domain.");
  await db().transaction(async (tx) => {
    const [locked] = await tx.select({ homepageUrl: companies.homepageUrl }).from(companies).where(eq(companies.id, id)).for("update");
    if (!locked) return;
    const changed = locked.homepageUrl !== homepageUrl;
    await tx.update(companies)
      .set({ homepageUrl, domain, ...(changed ? { faviconUrl: null } : {}), ...(name ? { name } : {}) })
      .where(eq(companies.id, id));
    if (changed) await enqueue("discover", { companyId: id, logoOnly: true, homepageUrl }, tx);
  });
  revalidateCatalogue(id);
  return { ok: true };
}

/**
 * Apply a follower's proposed name. The rename and the resolution are one transaction, so a name
 * can never be taken from a suggestion that still reads as pending, and applying the same row
 * from two tabs renames nothing the second time.
 */
export async function applyNameSuggestion(suggestionId: string): Promise<void> {
  const admin = await requireAdmin();
  const id = zUuid().parse(suggestionId);
  const applied = await db().transaction(async tx => applySuggestedName(tx, id, admin.id));
  revalidateCatalogue(applied?.companyId);
}

/** Turn a proposal down. It leaves the administrator's queue; the follower may propose another. */
export async function dismissNameSuggestion(suggestionId: string): Promise<void> {
  const admin = await requireAdmin();
  const id = zUuid().parse(suggestionId);
  const [dismissed] = await db().update(companyNameSuggestions)
    .set({ status: "dismissed", resolvedBy: admin.id, resolvedAt: new Date() })
    .where(and(eq(companyNameSuggestions.id, id), eq(companyNameSuggestions.status, "pending")))
    .returning({ companyId: companyNameSuggestions.companyId });
  revalidateCatalogue(dismissed?.companyId);
}

/** The archive event a retired source leaves on each view it puts away; `cause` is for code, `reason` for people. */
const SOURCE_RETIRED_EVENT = JSON.stringify({ action: "archived", actor: "system", reason: "Its careers source is no longer checked", cause: "source_retired" });

/**
 * Retire a shared source for every follower: nothing scans it again. It is not deleted — deleting
 * it cascaded to its scans, every posting it ever saw and every follower's view of them — so its
 * postings and scan history stay, and open roles stay open, because only a successful scan closes
 * a role. Followers' views of its roles move to Archived, except the ones a person has worked on:
 * a decision, a CV, an application or a role they added themselves keeps its place, as it does
 * when a gate narrows.
 */
export async function removeCatalogueSource(sourceId: string): Promise<void> {
  await requireAdmin();
  const id = zUuid().parse(sourceId);
  const companyId = await db().transaction(async (tx) => {
    const [source] = await tx.update(careerSources).set({ status: "disabled" }).where(eq(careerSources.id, id)).returning({ companyId: careerSources.companyId });
    if (!source) return null;
    // Lock the views first, in the order every other writer takes them, then read decisions and
    // CVs in a fresh statement: a shortlist committed while this waited must keep its role.
    await tx.execute(sql`select uj.user_id from user_jobs uj join jobs j on j.id = uj.job_id
      where j.source_id = ${id} and uj.archived_at is null
      order by uj.user_id, uj.job_id for update of uj`);
    await tx.execute(sql`with retired as (
        update user_jobs uj set archived_at = now(), updated_at = now()
        from jobs j
        where j.id = uj.job_id and j.source_id = ${id} and uj.archived_at is null
          and j.added_by is distinct from uj.user_id
          and not exists (select 1 from decisions d where d.user_id = uj.user_id and d.job_id = uj.job_id and d.superseded = false)
          and not exists (select 1 from cv_drafts c where c.user_id = uj.user_id and c.job_id = uj.job_id)
          and not exists (select 1 from applications a where a.user_id = uj.user_id and a.job_id = uj.job_id)
        returning uj.user_id, uj.job_id)
      insert into job_events (job_id, user_id, type, payload)
      select job_id, user_id, 'updated', ${SOURCE_RETIRED_EVENT}::jsonb from retired`);
    // The shared postings: a source nobody scans any more cannot close its roles by the two-miss
    // rule, so they are closed now, as of when they were last seen.
    await retireSourceRoles(tx, { sourceId: id });
    return source.companyId;
  });
  revalidateCatalogue(companyId);
}

/** Remove the company for everyone. Followers' decision snapshots survive; their views do not. */
export async function removeCatalogueCompany(companyId: string): Promise<void> {
  await requireAdmin();
  const id = zUuid().parse(companyId);
  // Foreign keys cascade postings, subscriptions and views, and retain denormalised decisions with job_id set to null.
  await db().delete(companies).where(eq(companies.id, id));
  revalidateCatalogue();
  redirect("/admin/catalogue");
}
