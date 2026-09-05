"use server";

import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { companies, filterSuggestions, preferenceProfiles } from "@christopher/db/schema";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
import { extractSuggestionValue } from "@/lib/filterSuggestions";
import { getSettings, setSetting } from "@/lib/settings";
import { zUuid } from "@/lib/validation";

async function getLatestProfileRow() {
  const rows = await db().select().from(preferenceProfiles).orderBy(desc(preferenceProfiles.version)).limit(1);
  return rows[0] ?? null;
}

export async function savePinnedStatements(formData: FormData): Promise<void> {
  const raw = String(formData.get("pinnedStatements") ?? "");
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const latest = await getLatestProfileRow();
  if (!latest) throw new Error("No preference profile exists yet.");
  await db().update(preferenceProfiles).set({ pinnedStatements: lines }).where(eq(preferenceProfiles.id, latest.id));
  await enqueue("synthesize_profile", { force: true });
  revalidatePath("/learning");
}

export async function answerOpenQuestion(questionId: string, formData: FormData): Promise<void> {
  const answer = String(formData.get("answer") ?? "").trim();
  if (!answer) throw new Error("An answer is required.");
  const latest = await getLatestProfileRow();
  if (!latest) throw new Error("No preference profile exists yet.");
  const questions = latest.openQuestions ?? [];
  const question = questions.find((q) => q.id === questionId);
  if (!question) throw new Error("Question not found.");

  const updatedQuestions = questions.map((q) => (q.id === questionId ? { ...q, answer } : q));
  const updatedPinned = [...latest.pinnedStatements, `Q: ${question.question} A: ${answer}`];
  await db()
    .update(preferenceProfiles)
    .set({ openQuestions: updatedQuestions, pinnedStatements: updatedPinned })
    .where(eq(preferenceProfiles.id, latest.id));
  await enqueue("synthesize_profile", { force: true });
  revalidatePath("/learning");
}

export async function saveSeedProfile(formData: FormData): Promise<void> {
  const text = String(formData.get("seedProfile") ?? "");
  await setSetting("seedProfile", text);
  revalidatePath("/learning");
  revalidatePath("/settings");
}

export async function acceptFilterSuggestion(suggestionId: string): Promise<void> {
  const id = zUuid().parse(suggestionId);
  const [suggestion] = await db().select().from(filterSuggestions).where(eq(filterSuggestions.id, id)).limit(1);
  if (!suggestion || suggestion.status !== "pending") return;

  const settings = await getSettings();
  const extracted = extractSuggestionValue(suggestion);

  if (suggestion.type === "keyword_include" && extracted.kind === "term") {
    await setSetting("gate", { ...settings.gate, includeKeywords: [...new Set([...settings.gate.includeKeywords, extracted.term])] });
  } else if (suggestion.type === "keyword_exclude" && extracted.kind === "term") {
    await setSetting("gate", { ...settings.gate, excludeKeywords: [...new Set([...settings.gate.excludeKeywords, extracted.term])] });
  } else if (suggestion.type === "location" && extracted.kind === "term") {
    await setSetting("gate", { ...settings.gate, locationTerms: [...new Set([...settings.gate.locationTerms, extracted.term])] });
  } else if (suggestion.type === "hide_threshold" && extracted.kind === "threshold") {
    await setSetting("hideThreshold", extracted.threshold);
  } else if (suggestion.type === "pause_company" && extracted.kind === "company") {
    await db().update(companies).set({ status: "paused" }).where(eq(companies.id, extracted.companyId));
  }

  await db().update(filterSuggestions).set({ status: "accepted", resolvedAt: new Date() }).where(eq(filterSuggestions.id, id));
  await enqueue("reevaluate_gate", {});
  revalidatePath("/learning");
  revalidatePath("/settings");
  revalidatePath("/");
}

export async function rejectFilterSuggestion(suggestionId: string): Promise<void> {
  const id = zUuid().parse(suggestionId);
  await db().update(filterSuggestions).set({ status: "rejected", resolvedAt: new Date() }).where(eq(filterSuggestions.id, id));
  revalidatePath("/learning");
}

export async function resynthesizeNow(): Promise<void> {
  await enqueue("synthesize_profile", { force: true });
  revalidatePath("/learning");
}

export async function rescoreAllRoles(): Promise<void> {
  await enqueue("rescore_all", { onlyInTable: true });
  revalidatePath("/learning");
  revalidatePath("/settings");
}
