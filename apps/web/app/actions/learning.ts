"use server";

import { requireUser, requireVerifiedUser } from "@/lib/auth";

import { appendProfile, latestProfileFor, ProfileVersionConflictError, setSubscriptionStatus, lockAccountScoreInput } from "@ava/db";
import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { filterSuggestions, tagVocabulary, userSettings, type FilterSuggestion, type User } from "@ava/db/schema";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
import { countRolesInTable } from "@/lib/queries/learning";
import { describeFilterSuggestion, extractSuggestionValue } from "@/lib/filterSuggestions";
import { getSettings, getSettingsFor, setUserSetting, saveSettingsAndGateLocked } from "@/lib/settings";
import { actionError, fail, isUserFacingError, UserFacingError, zUuid, type ActionResult } from "@/lib/validation";
import { refuseOn, revalidate } from "@/lib/action-helpers";

/**
 * Pinned statements and answers go into every profile synthesis verbatim, so each one is a
 * sentence or a paragraph rather than a document, and there are only so many of them.
 */
const PINNED_STATEMENT_LIMIT = 2_000;
const PINNED_STATEMENTS_MAX = 50;

const PROFILE_CHANGED = "Your preference profile changed since this page loaded. Your edits are still here. Open the latest profile in a new tab, compare it with this draft and copy across the changes you want to keep.";

/**
 * Append a version the person wrote. The worker writes versions too — a synthesis is queued after
 * most decisions — so a page opened before one landed is stale, which is a refusal with a reason.
 */
async function appendOwnProfile(userId: string, expectedVersion: number, input: Parameters<typeof appendProfile>[3], synthesize = false): Promise<void> {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new UserFacingError(PROFILE_CHANGED);
  try {
    await db().transaction(async tx => {
      await appendProfile(tx as unknown as ReturnType<typeof db>, userId, expectedVersion, input);
      if (synthesize) await enqueue("synthesize_profile", { userId, force: true }, tx);
    });
  } catch (error) {
    if (error instanceof ProfileVersionConflictError) throw new UserFacingError(PROFILE_CHANGED);
    throw error;
  }
}

function versionFrom(formData: FormData): number {
  // Never substitute the current version when a form omits its guard.
  const raw = formData.get("profileVersion");
  return typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
}

function refuseLegacy(result: ActionResult): void {
  if (!result.ok) refuseOn("/learning", result.error);
}

function profileFailure(error: unknown): ActionResult {
  if (!isUserFacingError(error)) throw error;
  return error.message === PROFILE_CHANGED
    ? fail(error.message, { href: "/learning", label: "Check the latest profile in a new tab" })
    : fail(error.message);
}

/**
 * Everything on Learning that ends in a model call — a profile synthesis or a re-score — waits for a
 * confirmed address, like every other action that spends (R-6.3's seed profile is the exception
 * below). Reading the page, rejecting a suggestion and accepting a tag spend nothing and do not.
 */
/** The gate list each term suggestion adds its term to. */
const GATE_FIELD_FOR: Partial<Record<FilterSuggestion["type"], "includeKeywords" | "seniorityKeywords" | "excludeKeywords" | "locationTerms">> = {
  keyword_include: "includeKeywords",
  seniority_include: "seniorityKeywords",
  keyword_exclude: "excludeKeywords",
  location: "locationTerms",
};

export async function savePinnedStatements(formData: FormData): Promise<void> {
  refuseLegacy(await savePinnedStatementsSetting({ ok: true }, formData));
}

export async function savePinnedStatementsSetting(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireVerifiedUser();
  const raw = String(formData.get("pinnedStatements") ?? "");
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > PINNED_STATEMENTS_MAX) return fail(`Pin at most ${PINNED_STATEMENTS_MAX} statements.`);
  if (lines.some((line) => line.length > PINNED_STATEMENT_LIMIT)) return fail(`Keep each pinned statement under ${PINNED_STATEMENT_LIMIT.toLocaleString("en-GB")} characters.`);
  const expectedVersion = versionFrom(formData);
  const latest = await latestProfileFor(db(), user.id);
  try {
    await appendOwnProfile(user.id, expectedVersion, {
      markdown: latest?.markdown ?? (await getSettings()).seedProfile,
      pinnedStatements: lines, openQuestions: latest?.openQuestions ?? [],
      sourceDecisionCount: latest?.sourceDecisionCount ?? 0, model: "user",
    }, true);
  } catch (error) { return profileFailure(error); }
  revalidatePath("/learning");
  return { ok: true, nextSnapshot: { profileVersion: String(expectedVersion + 1) } };
}

export async function answerOpenQuestion(questionId: string, formData: FormData): Promise<void> {
  refuseLegacy(await answerOpenQuestionSetting(questionId, { ok: true }, formData));
}

export async function answerOpenQuestionSetting(questionId: string, _prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireVerifiedUser();
  const answer = String(formData.get("answer") ?? "").trim();
  if (!answer) return fail("Write an answer before saving it.");
  if (answer.length > PINNED_STATEMENT_LIMIT) return fail(`Keep an answer under ${PINNED_STATEMENT_LIMIT.toLocaleString("en-GB")} characters.`);
  const expectedVersion = versionFrom(formData);
  const latest = await latestProfileFor(db(), user.id);
  const questions = latest?.openQuestions ?? [];
  const question = questions.find((q) => q.id === questionId);
  if (!latest || !question || question.answer) return profileFailure(new UserFacingError(PROFILE_CHANGED));
  if (latest.pinnedStatements.length >= PINNED_STATEMENTS_MAX) return fail(`Your profile already pins ${PINNED_STATEMENTS_MAX} statements. Remove one before answering.`);

  const updatedQuestions = questions.map((q) => (q.id === questionId ? { ...q, answer } : q));
  const updatedPinned = [...latest.pinnedStatements, `Q: ${question.question} A: ${answer}`];
  try {
    await appendOwnProfile(user.id, expectedVersion, {
      markdown: latest.markdown, openQuestions: updatedQuestions, pinnedStatements: updatedPinned,
      sourceDecisionCount: latest.sourceDecisionCount, model: "user",
    }, true);
  } catch (error) { return profileFailure(error); }
  revalidatePath("/learning");
  return { ok: true, nextSnapshot: { profileVersion: String(expectedVersion + 1) } };
}

/** A few sentences, not a document: long enough for deal-breakers, short enough to stay readable. */
const SEED_PROFILE_LIMIT = 5_000;

/**
 * The one write behind both seed-profile cards (R-6.3). Settings is where setup asks for it and
 * Learning is where it stays editable, so the two forms differ only in what they return.
 *
 * Setup asks for the seed profile before the address is confirmed, so the text is saved for any
 * account; the synthesis it prompts is model work and waits for the confirmation. Nothing is lost
 * by waiting: scoring reads the seed profile itself until a synthesised one exists, and confirming
 * the account queues synthesis for a saved seed.
 */
async function writeSeedProfile(user: User, raw: string): Promise<string | null> {
  const text = String(raw ?? "");
  if (text.length > SEED_PROFILE_LIMIT) return `Keep your seed profile under ${SEED_PROFILE_LIMIT.toLocaleString("en-GB")} characters. A few sentences is plenty.`;
  await setUserSetting(user.id, "seedProfile", text);
  revalidate("/learning", "/settings", "/");
  return null;
}

export async function saveSeedProfile(formData: FormData): Promise<void> {
  refuseLegacy(await saveSeedProfileSetting({ ok: true }, formData));
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
export async function acceptFilterSuggestionWithReport(suggestionId: string, throwUnexpected = false): Promise<ActionResult> {
  // Accepting re-evaluates the gate and re-scores the table, which is model work.
  const user = await requireVerifiedUser();
  const parsedId = zUuid().safeParse(suggestionId);
  if (!parsedId.success) return fail("Suggestion not found.");
  const id = parsedId.data;
  try {
    const result = await db().transaction(async tx => {
      await lockAccountScoreInput(tx as unknown as ReturnType<typeof db>, user.id, "exclusive");
      // This is the same lock used by a manual gate save. Read the gate only after taking it, so
      // accepting two terms from separate tabs cannot replace the first with a stale whole gate.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`settings:${user.id}`}))`);
      const [suggestion] = await tx.select().from(filterSuggestions)
        .where(and(eq(filterSuggestions.id, id), eq(filterSuggestions.userId, user.id))).for("update").limit(1);
      if (!suggestion || suggestion.status !== "pending") return fail("That suggestion has already been settled.");
      const extracted = extractSuggestionValue(suggestion);
      const field = GATE_FIELD_FOR[suggestion.type];
      if (field) {
        if (extracted.kind !== "term") return fail("This suggestion has no usable term. Reject it instead.");
        // Suggestions must not turn an untouched default gate into the account's first choice.
        const [savedGate] = await tx.select({ key: userSettings.key }).from(userSettings)
          .where(and(eq(userSettings.userId, user.id), eq(userSettings.key, "gate"))).limit(1);
        if (!savedGate) return fail("Choose your keywords and locations before accepting a filter suggestion.");
        const settings = await getSettingsFor(user.id, tx as unknown as ReturnType<typeof db>);
        const before = await countRolesInTable(user.id, tx as unknown as ReturnType<typeof db>);
        await saveSettingsAndGateLocked(tx, user.id, { gate: { ...settings.gate, [field]: [...new Set([...(settings.gate[field] ?? []), extracted.term])] } });
        const admitted = Math.max(0, (await countRolesInTable(user.id, tx as unknown as ReturnType<typeof db>)) - before);
        await tx.update(filterSuggestions).set({ status: "accepted", resolvedAt: new Date() })
          .where(and(eq(filterSuggestions.id, id), eq(filterSuggestions.userId, user.id), eq(filterSuggestions.status, "pending")));
        const term = `“${extracted.term}”`;
        return { ok: true as const, message: admitted > 0
          ? `Added ${term}. Admitted ${admitted} ${admitted === 1 ? "role" : "roles"}.`
          : `Added ${term}. No stored role matched it yet; the table updates as the re-evaluation runs.` };
      }
      if (suggestion.type === "hide_threshold") {
        await tx.update(filterSuggestions).set({ status: "rejected", resolvedAt: new Date() })
          .where(and(eq(filterSuggestions.id, id), eq(filterSuggestions.userId, user.id), eq(filterSuggestions.status, "pending")));
        return { ok: true as const, message: "Settled: hiding roles by score is retired." };
      }
      if (suggestion.type === "pause_company") {
        if (extracted.kind !== "company") return fail("This suggestion does not name a company you follow. Reject it and pause the company from Companies instead.");
        if (!(await setSubscriptionStatus(tx as unknown as ReturnType<typeof db>, user.id, extracted.companyId, "paused"))) return fail("You no longer follow that company, so there is nothing to pause.");
        await tx.update(filterSuggestions).set({ status: "accepted", resolvedAt: new Date() })
          .where(and(eq(filterSuggestions.id, id), eq(filterSuggestions.userId, user.id), eq(filterSuggestions.status, "pending")));
        return { ok: true as const, message: "Paused that company; its roles stop arriving." };
      }
      return fail(`Cannot accept ${describeFilterSuggestion(suggestion)}.`);
    });
    if (result.ok) revalidate("/learning", "/settings", "/");
    return result;
  } catch (error) {
    if (throwUnexpected && !isUserFacingError(error)) throw error;
    return actionError(error, "Could not accept that suggestion. Please try again.");
  }
}

/** The Learning card's form-shaped twin of `acceptFilterSuggestionWithReport`: a refusal goes back to the page. */
export async function acceptFilterSuggestion(suggestionId: string): Promise<void> {
  const result = await acceptFilterSuggestionWithReport(suggestionId);
  if (!result.ok) refuseOn("/learning", result.error);
}

export async function acceptFilterSuggestionSetting(suggestionId: string, _prev: ActionResult, _formData: FormData): Promise<ActionResult> {
  return acceptFilterSuggestionWithReport(suggestionId, true);
}

/** Mine the latest scan of every source for role types and seniority labels the gate is missing. */
export async function suggestFromScansNow(): Promise<void> {
  refuseLegacy(await suggestFromScansNowSetting({ ok: true }, new FormData()));
}

export async function suggestFromScansNowSetting(_prev: ActionResult, _formData: FormData): Promise<ActionResult> {
  const user = await requireVerifiedUser();
  await enqueue("suggest_from_scans", { userId: user.id });
  revalidatePath("/learning");
  return { ok: true };
}

export async function rejectFilterSuggestion(suggestionId: string): Promise<void> {
  refuseLegacy(await rejectFilterSuggestionSetting(suggestionId, { ok: true }, new FormData()));
}

export async function rejectFilterSuggestionSetting(suggestionId: string, _prev: ActionResult, _formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = zUuid().safeParse(suggestionId);
  if (!parsed.success) return fail("That suggestion has already been settled.");
  const id = parsed.data;
  const updated = await db().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`settings:${user.id}`}))`);
    return tx.update(filterSuggestions).set({ status: "rejected", resolvedAt: new Date() })
      .where(and(eq(filterSuggestions.id, id), eq(filterSuggestions.userId, user.id), eq(filterSuggestions.status, "pending"))).returning({ id: filterSuggestions.id });
  });
  if (!updated.length) return { ok: true };
  // The Roles page's suggestions strip lists pending suggestions and dismisses from there.
  revalidate("/learning", "/");
  return { ok: true };
}

export async function resynthesizeNow(): Promise<void> {
  refuseLegacy(await resynthesizeNowSetting({ ok: true }, new FormData()));
}

export async function resynthesizeNowSetting(_prev: ActionResult, _formData: FormData): Promise<ActionResult> {
  const user = await requireVerifiedUser();
  await enqueue("synthesize_profile", { userId: user.id, force: true });
  revalidatePath("/learning");
  return { ok: true };
}

export async function rescoreAllRoles(): Promise<void> {
  refuseLegacy(await rescoreAllRolesSetting({ ok: true }, new FormData()));
}

export async function rescoreAllRolesSetting(_prev: ActionResult, _formData: FormData): Promise<ActionResult> {
  const user = await requireVerifiedUser();
  await enqueue("rescore_all", { userId: user.id, onlyInTable: true });
  revalidate("/learning", "/settings");
  return { ok: true };
}

export async function savePreferenceProfile(formData: FormData): Promise<void> {
  refuseLegacy(await savePreferenceProfileSetting({ ok: true }, formData));
}

export async function savePreferenceProfileSetting(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireVerifiedUser();
  const markdown = String(formData.get("markdown") ?? "").trim();
  if (!markdown || markdown.length > 50_000) return fail("Enter a profile of between 1 and 50,000 characters.");
  const expectedVersion = versionFrom(formData);
  const latest = await latestProfileFor(db(), user.id);
  try {
    await appendOwnProfile(user.id, expectedVersion, {
      markdown, pinnedStatements: latest?.pinnedStatements ?? [], openQuestions: latest?.openQuestions ?? [],
      sourceDecisionCount: latest?.sourceDecisionCount ?? 0, model: "user",
    });
  } catch (error) { return profileFailure(error); }
  revalidatePath("/learning");
  return { ok: true, nextSnapshot: { profileVersion: String(expectedVersion + 1) } };
}

export async function acceptReasonTag(tag: string): Promise<void> {
  refuseLegacy(await acceptReasonTagSetting(tag, { ok: true }, new FormData()));
}

export async function acceptReasonTagSetting(tag: string, _prev: ActionResult, _formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!tag || tag.length > 100) return fail("That reason tag is not in your list.");
  const updated = await db().update(tagVocabulary).set({ accepted: true }).where(and(eq(tagVocabulary.userId, user.id), eq(tagVocabulary.tag, tag))).returning({ tag: tagVocabulary.tag });
  if (!updated.length) return fail("That reason tag is not in your list.");
  revalidatePath("/learning");
  return { ok: true };
}
