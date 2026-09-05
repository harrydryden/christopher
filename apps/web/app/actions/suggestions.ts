"use server";

import { requireSession } from "@/lib/auth";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { careerSources, companies, companySuggestions, SOURCE_TYPES } from "@christopher/db/schema";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
import { zUuid } from "@/lib/validation";

export async function acceptSuggestion(suggestionId: string): Promise<void> {
  await requireSession();
  const id = zUuid().parse(suggestionId);
  const [suggestion] = await db().select().from(companySuggestions).where(eq(companySuggestions.id, id)).limit(1);
  if (!suggestion || suggestion.status !== "pending") return;

  const [company] = await db()
    .insert(companies)
    .values({ name: suggestion.name, homepageUrl: suggestion.homepageUrl, domain: suggestion.domain })
    .returning({ id: companies.id });
  if (!company) throw new Error("Failed to create the company.");

  const cs = suggestion.verification?.careersSource;
  if (cs && (SOURCE_TYPES as readonly string[]).includes(cs.type)) {
    await db().insert(careerSources).values({
      companyId: company.id,
      type: cs.type as (typeof SOURCE_TYPES)[number],
      url: cs.url,
      confidence: cs.confidence,
      confirmedByUser: true,
      discoveryMethod: "suggestion_verification",
      status: "active",
    });
  }

  await db().update(companySuggestions).set({ status: "accepted", resolvedAt: new Date() }).where(eq(companySuggestions.id, id));

  await enqueue("scan_company", { companyId: company.id, trigger: "manual" });
  await enqueue("profile_company", { companyId: company.id });

  revalidatePath("/suggestions");
  revalidatePath("/companies");
}

export async function rejectSuggestion(suggestionId: string, formData: FormData): Promise<void> {
  await requireSession();
  const id = zUuid().parse(suggestionId);
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) throw new Error("A reason is required to reject a suggestion.");

  await db()
    .update(companySuggestions)
    .set({ status: "rejected", rejectionReason: reason, resolvedAt: new Date() })
    .where(eq(companySuggestions.id, id));

  await enqueue("synthesize_profile", { force: false });
  revalidatePath("/suggestions");
}

export async function findMoreSuggestions(): Promise<void> {
  await requireSession();
  await enqueue("suggest_companies", {});
  revalidatePath("/suggestions");
}
