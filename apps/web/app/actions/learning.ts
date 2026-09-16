"use server";

import { requireUser } from "@/lib/auth";

import { appendProfile, latestProfileFor, setSubscriptionStatus } from "@christopher/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { filterSuggestions, tagVocabulary } from "@christopher/db/schema";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
import { extractSuggestionValue } from "@/lib/filterSuggestions";
import { getSettings, setUserSetting, saveSettingsAndGate } from "@/lib/settings";
import { zUuid } from "@/lib/validation";

export async function savePinnedStatements(formData: FormData): Promise<void> {
  const user = await requireUser();
  const raw = String(formData.get("pinnedStatements") ?? "");
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const latest = await latestProfileFor(db(), user.id);
  const expectedVersion = Number(formData.get("profileVersion") ?? latest?.version ?? 0);
  await appendProfile(db(), user.id, expectedVersion, {
    markdown: latest?.markdown ?? (await getSettings()).seedProfile,
    pinnedStatements: lines, openQuestions: latest?.openQuestions ?? [],
    sourceDecisionCount: latest?.sourceDecisionCount ?? 0, model: "user",
  });
  await enqueue("synthesize_profile", { userId: user.id, force: true });
  revalidatePath("/learning");
}

export async function answerOpenQuestion(questionId: string, formData: FormData): Promise<void> {
  const user = await requireUser();
  const answer = String(formData.get("answer") ?? "").trim();
  if (!answer) throw new Error("An answer is required.");
  const latest = await latestProfileFor(db(), user.id);
  if (!latest) throw new Error("No preference profile exists yet.");
  const questions = latest.openQuestions ?? [];
  const question = questions.find((q) => q.id === questionId);
  if (!question) throw new Error("Question not found.");

  const updatedQuestions = questions.map((q) => (q.id === questionId ? { ...q, answer } : q));
  const updatedPinned = [...latest.pinnedStatements, `Q: ${question.question} A: ${answer}`];
  const expectedVersion = Number(formData.get("profileVersion") ?? latest.version);
  await appendProfile(db(), user.id, expectedVersion, {
    markdown: latest.markdown, openQuestions: updatedQuestions, pinnedStatements: updatedPinned,
    sourceDecisionCount: latest.sourceDecisionCount, model: "user",
  });
  await enqueue("synthesize_profile", { userId: user.id, force: true });
  revalidatePath("/learning");
}

export async function saveSeedProfile(formData: FormData): Promise<void> {
  const user = await requireUser();
  const text = String(formData.get("seedProfile") ?? "");
  await setUserSetting(user.id, "seedProfile", text);
  await enqueue("synthesize_profile", { userId: user.id, force: true });
  revalidatePath("/learning");
  revalidatePath("/settings");
}

export async function acceptFilterSuggestion(suggestionId: string): Promise<void> {
  const user = await requireUser();
  const id = zUuid().parse(suggestionId);
  const [suggestion] = await db().select().from(filterSuggestions).where(and(eq(filterSuggestions.id, id), eq(filterSuggestions.userId, user.id))).limit(1);
  if (!suggestion || suggestion.status !== "pending") return;

  const settings = await getSettings();
  const extracted = extractSuggestionValue(suggestion);

  if (suggestion.type === "keyword_include" && extracted.kind === "term") {
    await saveSettingsAndGate(user.id, { gate: { ...settings.gate, includeKeywords: [...new Set([...settings.gate.includeKeywords, extracted.term])] } });
  } else if (suggestion.type === "seniority_include" && extracted.kind === "term") {
    await saveSettingsAndGate(user.id, { gate: { ...settings.gate, seniorityKeywords: [...new Set([...(settings.gate.seniorityKeywords ?? []), extracted.term])] } });
  } else if (suggestion.type === "keyword_exclude" && extracted.kind === "term") {
    await saveSettingsAndGate(user.id, { gate: { ...settings.gate, excludeKeywords: [...new Set([...settings.gate.excludeKeywords, extracted.term])] } });
  } else if (suggestion.type === "location" && extracted.kind === "term") {
    await saveSettingsAndGate(user.id, { gate: { ...settings.gate, locationTerms: [...new Set([...settings.gate.locationTerms, extracted.term])] } });
  } else if (suggestion.type === "hide_threshold" && extracted.kind === "threshold") {
    throw new Error("Automatic score hiding has been retired. Use the minimum fit filter on Roles.");
  } else if (suggestion.type === "pause_company" && extracted.kind === "company") {
    await setSubscriptionStatus(db(), user.id, extracted.companyId, "paused");
  }

  await db().update(filterSuggestions).set({ status: "accepted", resolvedAt: new Date() }).where(eq(filterSuggestions.id, id));
  await enqueue("reevaluate_gate", { userId: user.id });
  revalidatePath("/learning");
  revalidatePath("/settings");
  revalidatePath("/");
}

/** Mine the latest scan of every source for role types and seniority labels the gate is missing. */
export async function suggestFromScansNow(): Promise<void> {
  const user = await requireUser();
  await enqueue("suggest_from_scans", { userId: user.id });
  revalidatePath("/learning");
}

export async function rejectFilterSuggestion(suggestionId: string): Promise<void> {
  const user = await requireUser();
  const id = zUuid().parse(suggestionId);
  await db().update(filterSuggestions).set({ status: "rejected", resolvedAt: new Date() }).where(and(eq(filterSuggestions.id, id), eq(filterSuggestions.userId, user.id)));
  revalidatePath("/learning");
}

export async function resynthesizeNow(): Promise<void> {
  const user = await requireUser();
  await enqueue("synthesize_profile", { userId: user.id, force: true });
  revalidatePath("/learning");
}

export async function rescoreAllRoles(): Promise<void> {
  const user = await requireUser();
  await enqueue("rescore_all", { userId: user.id, onlyInTable: true });
  revalidatePath("/learning");
  revalidatePath("/settings");
}

export async function savePreferenceProfile(formData: FormData): Promise<void> {
  const user = await requireUser();
  const markdown = String(formData.get("markdown") ?? "").trim();
  if (!markdown || markdown.length > 50_000) throw new Error("Enter a profile of between 1 and 50,000 characters.");
  const expectedVersion = Number(formData.get("profileVersion") ?? 0);
  const latest = await latestProfileFor(db(), user.id);
  await appendProfile(db(), user.id, expectedVersion, {
    markdown, pinnedStatements: latest?.pinnedStatements ?? [], openQuestions: latest?.openQuestions ?? [],
    sourceDecisionCount: latest?.sourceDecisionCount ?? 0, model: "user",
  });
  await enqueue("rescore_all", { userId: user.id, onlyInTable: true });
  revalidatePath("/learning");
}

export async function acceptReasonTag(tag: string): Promise<void> {
  const user = await requireUser();
  if (!tag || tag.length > 100) throw new Error("Invalid reason tag.");
  await db().update(tagVocabulary).set({ accepted: true }).where(and(eq(tagVocabulary.userId, user.id), eq(tagVocabulary.tag, tag)));
  revalidatePath("/learning");
}
