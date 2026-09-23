"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { careerSources, companies, companyNameSuggestions } from "@ava/db/schema";
import { ensureHttpUrl, extractDomain } from "@ava/core";
import { requireAdmin } from "@/lib/auth";
import { applySuggestedName, normaliseCompanyName } from "@/lib/company-names";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
import { fail, zUuid, type ActionResult } from "@/lib/validation";

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

/** Deleting a shared source affects every follower. Its scan history stays; it is simply no longer scanned. */
export async function removeCatalogueSource(sourceId: string): Promise<void> {
  await requireAdmin();
  const id = zUuid().parse(sourceId);
  const [source] = await db().select({ companyId: careerSources.companyId }).from(careerSources).where(eq(careerSources.id, id)).limit(1);
  await db().delete(careerSources).where(eq(careerSources.id, id));
  revalidateCatalogue(source?.companyId);
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
