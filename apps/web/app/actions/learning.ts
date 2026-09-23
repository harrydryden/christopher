"use server";

import { needsEmailConfirmation, requireUser, requireVerifiedUser } from "@/lib/auth";

import { appendProfile, latestProfileFor, setSubscriptionStatus } from "@ava/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { filterSuggestions, tagVocabulary, type User } from "@ava/db/schema";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
import { countRolesInTable } from "@/lib/queries/learning";
import { describeFilterSuggestion, extractSuggestionValue } from "@/lib/filterSuggestions";
import { getSettings, setUserSetting, saveSettingsAndGate } from "@/lib/settings";
import { actionError, fail, UserFacingError, zUuid, type ActionResult } from "@/lib/validation";

/**
 * Everything on Learning that ends in a model call — a profile synthesis or a re-score — waits for a
 * confirmed address, like every other action that spends (R-6.3's seed profile is the exception
 * below). Reading the page, rejecting a suggestion and accepting a tag spend nothing and do not.
 */
export async function savePinnedStatements(formData: FormData): Promise<void> {
  const user = await requireVerifiedUser();
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
  const user = await requireVerifiedUser();
  const answer = String(formData.get("answer") ?? "").trim();
  if (!answer) throw new UserFacingError("An answer is required.");
  const latest = await latestProfileFor(db(), user.id);
  if (!latest) throw new UserFacingError("No preference profile exists yet.");
  const questions = latest.openQuestions ?? [];
  const question = questions.find((q) => q.id === questionId);
  if (!question) throw new UserFacingError("Question not found.");

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

/** A few sentences, not a document: long enough for deal-breakers, short enough to stay readable. */
const SEED_PROFILE_LIMIT = 5_000;

/**
 * The one write behind both seed-profile cards (R-6.3). Settings is where setup asks for it and
 * Learning is where it stays editable, so the two forms differ only in what they return.
 *
 * Setup asks for the seed profile before the address is confirmed, so the text is saved for any
 * account; the synthesis it prompts is model work and waits for the confirmation. Nothing is lost
 * by waiting: scoring reads the seed profile itself until a synthesised one exists, and the first
 * decision after confirming queues the synthesis.
 */
async function writeSeedProfile(user: User, raw: string): Promise<string | null> {
  const text = String(raw ?? "");
  if (text.length > SEED_PROFILE_LIMIT) return `Keep your seed profile under ${SEED_PROFILE_LIMIT.toLocaleString("en-GB")} characters. A few sentences is plenty.`;
  await setUserSetting(user.id, "seedProfile", text);
  if (!needsEmailConfirmation(user)) await enqueue("synthesize_profile", { userId: user.id, force: true });
  revalidatePath("/learning");
  revalidatePath("/settings");
  revalidatePath("/");
  return null;
}

export async function saveSeedProfile(formData: FormData): Promise<void> {
  const user = await requireUser();
  const error = await writeSeedProfile(user, String(formData.get("seedProfile") ?? ""));
  if (error) throw new UserFacingError(error);
}

/** The Settings card's twin, for a `SettingsForm` that shows its errors inline. */
export async function saveSeedProfileSetting(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const error = await writeSeedProfile(user, String(formData.get("seedProfile") ?? ""));
  return error ? fail(error) : { ok: true };
}

/**
 * Accept a suggestion and say what it did. Widening the gate re-evaluates it inline for a small
 * account and in the background for a large one, and either way the number a person wants is how
 * many roles appeared in their table — counted either side of the save, because
 * `saveSettingsAndGate` returns nothing and the queued path admits nothing yet.
 *
 * `acceptFilterSuggestion` below is the same work with nothing to say: the Learning card binds it
 * straight into a `<form action>`, which React types as returning nothing at all.
 */
export async function acceptFilterSuggestionWithReport(suggestionId: string): Promise<ActionResult> {
  // Accepting re-evaluates the gate and re-scores the table, which is model work.
  const user = await requireVerifiedUser();
  const parsedId = zUuid().safeParse(suggestionId);
  if (!parsedId.success) return fail("Suggestion not found.");
  const id = parsedId.data;
  try {
    const [suggestion] = await db().select().from(filterSuggestions).where(and(eq(filterSuggestions.id, id), eq(filterSuggestions.userId, user.id))).limit(1);
    if (!suggestion || suggestion.status !== "pending") return fail("That suggestion has already been settled.");

    const settings = await getSettings();
    const extracted = extractSuggestionValue(suggestion);
    const before = await countRolesInTable(user.id);

    if (suggestion.type === "keyword_include" && extracted.kind === "term") {
      await saveSettingsAndGate(user.id, { gate: { ...settings.gate, includeKeywords: [...new Set([...settings.gate.includeKeywords, extracted.term])] } });
    } else if (suggestion.type === "seniority_include" && extracted.kind === "term") {
      await saveSettingsAndGate(user.id, { gate: { ...settings.gate, seniorityKeywords: [...new Set([...(settings.gate.seniorityKeywords ?? []), extracted.term])] } });
    } else if (suggestion.type === "keyword_exclude" && extracted.kind === "term") {
      await saveSettingsAndGate(user.id, { gate: { ...settings.gate, excludeKeywords: [...new Set([...settings.gate.excludeKeywords, extracted.term])] } });
    } else if (suggestion.type === "location" && extracted.kind === "term") {
      await saveSettingsAndGate(user.id, { gate: { ...settings.gate, locationTerms: [...new Set([...settings.gate.locationTerms, extracted.term])] } });
    } else if (suggestion.type === "hide_threshold") {
      // Automatic score hiding is retired. A suggestion stored before that is resolved rather than
      // applied, so Accept on a stale page settles it instead of failing.
      await db().update(filterSuggestions).set({ status: "rejected", resolvedAt: new Date() }).where(eq(filterSuggestions.id, id));
      revalidatePath("/learning");
      return { ok: true, message: "Settled: hiding roles by score is retired." };
    } else if (suggestion.type === "pause_company" && extracted.kind === "company") {
      await setSubscriptionStatus(db(), user.id, extracted.companyId, "paused");
    }

    await db().update(filterSuggestions).set({ status: "accepted", resolvedAt: new Date() }).where(eq(filterSuggestions.id, id));
    await enqueue("reevaluate_gate", { userId: user.id });
    revalidatePath("/learning");
    revalidatePath("/settings");
    revalidatePath("/");

    if (suggestion.type === "pause_company") return { ok: true, message: "Paused that company; its roles stop arriving." };
    const admitted = Math.max(0, (await countRolesInTable(user.id)) - before);
    const term = extracted.kind === "term" ? `“${extracted.term}”` : describeFilterSuggestion(suggestion).toLowerCase();
    return {
      ok: true,
      message: admitted > 0
        ? `Added ${term}. Admitted ${admitted} ${admitted === 1 ? "role" : "roles"}.`
        : `Added ${term}. No stored role matched it yet; the table updates as the re-evaluation runs.`,
    };
  } catch (error) {
    return actionError(error, "Could not accept that suggestion. Please try again.");
  }
}

/** The Learning card's form-shaped twin of `acceptFilterSuggestionWithReport`. */
export async function acceptFilterSuggestion(suggestionId: string): Promise<void> {
  await acceptFilterSuggestionWithReport(suggestionId);
}

/** Mine the latest scan of every source for role types and seniority labels the gate is missing. */
export async function suggestFromScansNow(): Promise<void> {
  const user = await requireVerifiedUser();
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
  const user = await requireVerifiedUser();
  await enqueue("synthesize_profile", { userId: user.id, force: true });
  revalidatePath("/learning");
}

export async function rescoreAllRoles(): Promise<void> {
  const user = await requireVerifiedUser();
  await enqueue("rescore_all", { userId: user.id, onlyInTable: true });
  revalidatePath("/learning");
  revalidatePath("/settings");
}

export async function savePreferenceProfile(formData: FormData): Promise<void> {
  const user = await requireVerifiedUser();
  const markdown = String(formData.get("markdown") ?? "").trim();
  if (!markdown || markdown.length > 50_000) throw new UserFacingError("Enter a profile of between 1 and 50,000 characters.");
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
  if (!tag || tag.length > 100) throw new UserFacingError("Invalid reason tag.");
  await db().update(tagVocabulary).set({ accepted: true }).where(and(eq(tagVocabulary.userId, user.id), eq(tagVocabulary.tag, tag)));
  revalidatePath("/learning");
}
