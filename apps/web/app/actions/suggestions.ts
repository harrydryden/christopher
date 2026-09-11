"use server";
import { requireSession } from "@/lib/auth";
import { eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { companies, companySuggestions } from "@christopher/db/schema";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
import { getSettings } from "@/lib/settings";
import { zUuid } from "@/lib/validation";
import type { DiscoveryActionResult } from "@/lib/discovery-ux";

export async function acceptSuggestion(suggestionId: string): Promise<DiscoveryActionResult> {
  await requireSession();
  const id = zUuid().parse(suggestionId);
  const result = await db().transaction(async tx => {
    const [suggestion] = await tx.select().from(companySuggestions).where(eq(companySuggestions.id, id)).for("update");
    if (!suggestion || suggestion.status !== "pending") return { ok: false as const, error: "This recommendation has already been reviewed. Refresh the page to see its status." };
    const [created] = await tx.insert(companies).values({ name: suggestion.name, homepageUrl: suggestion.homepageUrl, domain: suggestion.domain }).onConflictDoNothing().returning({ id: companies.id });
    if (created) {
      // Resolve a full careers spec (including ATS identifiers), then let discovery queue the scan.
      await enqueue("discover", { companyId: created.id, url: suggestion.verification?.careersSource?.url, reason: "added" }, tx);
      await enqueue("profile_company", { companyId: created.id }, tx);
    }
    await tx.update(companySuggestions).set({ status: "accepted", resolvedAt: new Date() }).where(eq(companySuggestions.id, id));
    return { ok: true as const, message: created ? `${suggestion.name} added to tracked companies. Careers setup is queued.` : `${suggestion.name} is already tracked. Recommendation marked as added.` };
  });
  revalidatePath("/suggestions"); revalidatePath("/companies");
  return result;
}

export async function rejectSuggestion(suggestionId: string, formData: FormData): Promise<DiscoveryActionResult> {
  await requireSession();
  const id = zUuid().parse(suggestionId);
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason || reason.length > 1000) return { ok: false, error: "Give a brief reason (up to 1,000 characters) so future recommendations can improve." };
  const result = await db().transaction(async tx => {
    const [suggestion] = await tx.select().from(companySuggestions).where(eq(companySuggestions.id, id)).for("update");
    if (!suggestion || suggestion.status !== "pending") return { ok: false as const, error: "This recommendation has already been reviewed. Refresh the page to see its status." };
    await tx.update(companySuggestions).set({ status: "rejected", rejectionReason: reason, resolvedAt: new Date() }).where(eq(companySuggestions.id, id));
    await enqueue("synthesize_profile", { force: false }, tx);
    return { ok: true as const, message: `${suggestion.name} dismissed. Your reason has been saved.` };
  });
  revalidatePath("/suggestions");
  return result;
}

export async function findMoreSuggestions(): Promise<DiscoveryActionResult> {
  await requireSession();
  if (!(await getSettings()).suggestionsEnabled) return { ok: false, error: "Enable company suggestions in Settings before running discovery." };
  const [tracked] = await db().select({ count: sql<number>`count(*)::int` }).from(companies).where(inArray(companies.status, ["active", "paused"]));
  if (!tracked?.count) return { ok: false, error: "Track a company first so we can find similar employers, or add an external source." };
  const queued = await enqueue("suggest_companies", {});
  revalidatePath("/suggestions");
  return { ok: true, message: queued ? "Similar-company search queued. This does not check your external sources." : "A similar-company search is already queued or running." };
}
