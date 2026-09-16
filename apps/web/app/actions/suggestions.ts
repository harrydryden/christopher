"use server";
import { requireUser } from "@/lib/auth";
import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { reevaluateGate, subscribeToCompany } from "@christopher/db";
import { careerSources, companies, companySubscriptions, companySuggestions, jobs, tasks } from "@christopher/db/schema";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
import { getSettings, getSettingsFor } from "@/lib/settings";
import { zUuid } from "@/lib/validation";
import type { DiscoveryActionResult } from "@/lib/discovery-ux";

export async function acceptSuggestion(suggestionId: string): Promise<DiscoveryActionResult> {
  const user = await requireUser();
  const id = zUuid().parse(suggestionId);
  const result = await db().transaction(async tx => {
    const [suggestion] = await tx.select().from(companySuggestions).where(and(eq(companySuggestions.id, id), eq(companySuggestions.userId, user.id))).for("update");
    if (!suggestion || suggestion.status !== "pending") return { ok: false as const, error: "This recommendation has already been reviewed. Refresh the page to see its status." };
    const [created] = await tx.insert(companies).values({ name: suggestion.name, homepageUrl: suggestion.homepageUrl, domain: suggestion.domain }).onConflictDoNothing().returning({ id: companies.id });
    const [company] = created ? [created] : await tx.select({ id: companies.id }).from(companies).where(eq(companies.domain, suggestion.domain)).limit(1);
    if (!company) throw new Error("Could not add the company.");
    const subscription = await subscribeToCompany(tx, user.id, company.id);
    if (created) {
      // Resolve a full careers spec (including ATS identifiers), then let discovery queue the scan.
      await enqueue("discover", { companyId: created.id, url: suggestion.verification?.careersSource?.url, reason: "added" }, tx);
      await enqueue("profile_company", { companyId: created.id }, tx);
    } else if (subscription.created || subscription.reactivated) {
      const sources = await tx.select({ status: careerSources.status }).from(careerSources).where(eq(careerSources.companyId, company.id));
      if (!sources.some(s => s.status === "active" || s.status === "failing" || s.status === "needs_confirmation")) {
        await enqueue("discover", { companyId: company.id, url: suggestion.verification?.careersSource?.url, reason: "added" }, tx);
      }
      const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(jobs).where(eq(jobs.companyId, company.id));
      if ((count?.n ?? 0) > 500) await tx.insert(tasks).values({ type: "reevaluate_gate", payload: { userId: user.id, companyId: company.id }, dedupeKey: `reevaluate_gate:${user.id}:${company.id}`, priority: 1 }).onConflictDoNothing();
      else await reevaluateGate(tx as unknown as ReturnType<typeof db>, user.id, await getSettingsFor(user.id, tx as unknown as ReturnType<typeof db>), new Date(), { companyId: company.id });
    }
    await tx.update(companySuggestions).set({ status: "accepted", resolvedAt: new Date() }).where(eq(companySuggestions.id, id));
    return { ok: true as const, message: created
      ? `${suggestion.name} added to tracked companies. Careers setup is queued.`
      : subscription.created || subscription.reactivated
        ? `${suggestion.name} is already in the shared catalogue; you now follow it and its matching roles are in your table.`
        : `${suggestion.name} is already in your companies. Recommendation marked as added.` };
  });
  revalidatePath("/suggestions"); revalidatePath("/companies"); revalidatePath("/");
  return result;
}

export async function rejectSuggestion(suggestionId: string, formData: FormData): Promise<DiscoveryActionResult> {
  const user = await requireUser();
  const id = zUuid().parse(suggestionId);
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason || reason.length > 1000) return { ok: false, error: "Give a brief reason (up to 1,000 characters) so future recommendations can improve." };
  const result = await db().transaction(async tx => {
    const [suggestion] = await tx.select().from(companySuggestions).where(and(eq(companySuggestions.id, id), eq(companySuggestions.userId, user.id))).for("update");
    if (!suggestion || suggestion.status !== "pending") return { ok: false as const, error: "This recommendation has already been reviewed. Refresh the page to see its status." };
    await tx.update(companySuggestions).set({ status: "rejected", rejectionReason: reason, resolvedAt: new Date() }).where(eq(companySuggestions.id, id));
    await enqueue("synthesize_profile", { userId: user.id, force: false }, tx);
    return { ok: true as const, message: `${suggestion.name} dismissed. Your reason has been saved.` };
  });
  revalidatePath("/suggestions");
  return result;
}

export async function findMoreSuggestions(): Promise<DiscoveryActionResult> {
  const user = await requireUser();
  if (!(await getSettings()).suggestionsEnabled) return { ok: false, error: "Enable company suggestions in Settings before running discovery." };
  const [tracked] = await db().select({ count: sql<number>`count(*)::int` }).from(companySubscriptions)
    .where(and(eq(companySubscriptions.userId, user.id), inArray(companySubscriptions.status, ["active", "paused"])));
  if (!tracked?.count) return { ok: false, error: "Track a company first so we can find similar employers, or add an external source." };
  const queued = await enqueue("suggest_companies", { userId: user.id });
  revalidatePath("/suggestions");
  return { ok: true, message: queued ? "Similar-company search queued. This does not check your external sources." : "A similar-company search is already queued or running." };
}
