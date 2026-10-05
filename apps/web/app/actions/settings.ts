"use server";

import { requireAdmin, requireUser } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { userSettings as userSettingsTable } from "@col/db/schema";
import { lockAccountScoreInput } from "@col/db";
import {
  isKnownModel, isValidScanTime, isValidTimezone, MAX_ACCOUNT_AI_BUDGET_USD, MAX_MEMBER_AI_BUDGET_USD, parseTermList, SCORING_BATCH_MINUTES_MAX,
  SCORING_BATCH_MINUTES_MIN, SCORING_MODES, scoringBatchMinutesFrom, type GateSettings, type MatchField,
} from "@col/core";
import { enqueue } from "@/lib/enqueue";
import { GATE_NEEDS_KEYWORD_SENTENCE } from "@/lib/setup";
import { getSettings, getSettingsFor, setSystemSetting, setUserSetting, saveSettingsAndGateLocked } from "@/lib/settings";
import { db } from "@/lib/db";
import { stageRoutesFromForm } from "@/lib/stage-routes";
import { fail, ok, type ActionResult } from "@/lib/validation";
import { revalidate } from "@/lib/action-helpers";

const MATCH_FIELDS: MatchField[] = ["title", "department", "description"];

/**
 * One reading of the gate fields, whichever form carried them: the Keywords card, the Location
 * filter card and the one GateSetup block all parse and validate here rather than three times.
 * A field the form does not carry is left as it is, so saving one card never clears another.
 */
function gateFromForm(formData: FormData, current: GateSettings): { ok: true; gate: GateSettings } | { ok: false; error: string } {
  const gate: GateSettings = { ...current };
  const terms = (name: string) => parseTermList(String(formData.get(name) ?? ""));
  if (formData.has("includeKeywords")) gate.includeKeywords = terms("includeKeywords");
  if (formData.has("excludeKeywords")) gate.excludeKeywords = terms("excludeKeywords");
  if (formData.has("seniorityKeywords")) gate.seniorityKeywords = terms("seniorityKeywords");
  // An unticked checkbox sends nothing, so the location field beside it is what says the form
  // carried this pair at all.
  if (formData.has("locationTerms")) {
    gate.locationTerms = terms("locationTerms");
    gate.includeRemote = formData.get("includeRemote") === "1";
  }
  // `evaluateGate` treats an empty include list as "everything matches", so a form that carries the
  // field must leave at least one keyword in it.
  if (formData.has("includeKeywords") && gate.includeKeywords.filter((keyword) => keyword.trim()).length === 0) {
    return { ok: false, error: GATE_NEEDS_KEYWORD_SENTENCE };
  }
  return { ok: true, gate };
}

/** The whole gate from one form: what the setup block and the Companies page save. */
export async function saveGate(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const result = await db().transaction(async tx => {
    await lockAccountScoreInput(tx as unknown as ReturnType<typeof db>, user.id, "exclusive");
    // Merge only submitted fields after taking the same per-account lock as suggestion acceptance.
    // Otherwise two cards or tabs can overwrite one another with a stale whole-gate read.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`settings:${user.id}`}))`);
    const [saved] = await tx.select({ key: userSettingsTable.key }).from(userSettingsTable)
      .where(and(eq(userSettingsTable.userId, user.id), eq(userSettingsTable.key, "gate"))).limit(1);
    // A first save must be the complete setup form. Otherwise the untouched half is inherited
    // from the application defaults and a location-only save silently chooses "operations".
    if (!saved && (!formData.has("includeKeywords") || !formData.has("locationTerms"))) {
      return fail("Choose your keywords and locations together before monitoring starts.");
    }
    const settings = await getSettingsFor(user.id, tx as unknown as ReturnType<typeof db>);
    const parsed = gateFromForm(formData, settings.gate);
    if (!parsed.ok) return fail(parsed.error);
    await saveSettingsAndGateLocked(tx, user.id, { gate: parsed.gate });
    return ok();
  });
  if (!result.ok) return result;
  revalidate("/settings", "/companies", "/");
  return result;
}

export async function saveMatchFields(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const result = await db().transaction(async tx => {
    await lockAccountScoreInput(tx as unknown as ReturnType<typeof db>, user.id, "exclusive");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`settings:${user.id}`}))`);
    const [saved] = await tx.select({ key: userSettingsTable.key }).from(userSettingsTable)
      .where(and(eq(userSettingsTable.userId, user.id), eq(userSettingsTable.key, "gate"))).limit(1);
    if (!saved) return fail("Save your keywords and locations first.");
    const settings = await getSettingsFor(user.id, tx as unknown as ReturnType<typeof db>);
    const raw = formData.getAll("matchFields").map(String);
    const matchFields = MATCH_FIELDS.filter((f) => raw.includes(f));
    await saveSettingsAndGateLocked(tx, user.id, { gate: { ...settings.gate, matchFields: matchFields.length ? matchFields : ["title"] } });
    return ok();
  });
  if (!result.ok) return result;
  revalidate("/settings", "/");
  return result;
}

/** Automatic score hiding is retired: a stored `hideThreshold` is left where it is and ignored. */
export async function saveTableSettings(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const showClosedDays = Number(formData.get("showClosedDays"));
  if (!Number.isInteger(showClosedDays) || showClosedDays < 0 || showClosedDays > 365) {
    return fail("Show-closed-days must be a whole number between 0 and 365.");
  }

  // A display setting: the gate does not read it, so it re-evaluates and re-scores nothing.
  await setUserSetting(user.id, "showClosedDays", showClosedDays);
  revalidate("/settings", "/");
  return ok();
}

/** Whether this account wants weekly similar-company recommendations and source checks. */
export async function saveSuggestionSettings(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  await setUserSetting(user.id, "suggestionsEnabled", formData.get("suggestionsEnabled") === "1");
  revalidate("/settings", "/suggestions");
  return ok();
}

/** Who may create an account: administrator addresses always can; everyone else only while this is on. */
export async function saveRegistrationSettings(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireAdmin();
  await setSystemSetting("registrationOpen", formData.get("registrationOpen") === "1");
  revalidate("/admin", "/signup");
  return ok();
}

/** The daily run and closure policy are shared by every account: administrators only. */
export async function saveSchedule(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireAdmin();
  const scanTime = String(formData.get("scanTime") ?? "").trim();
  if (!isValidScanTime(scanTime)) return fail("Scan time must be in HH:MM 24-hour format, e.g. 06:00.");

  const timezone = String(formData.get("timezone") ?? "").trim();
  if (!isValidTimezone(timezone)) return fail("Not a recognised timezone. Use an IANA name, e.g. Europe/London.");

  const closeAfterMissingScans = Number(formData.get("closeAfterMissingScans"));
  if (!Number.isInteger(closeAfterMissingScans) || closeAfterMissingScans < 2 || closeAfterMissingScans > 5) {
    return fail("Close-after-missing-scans must be a whole number between 2 and 5.");
  }

  const respectRobotsTxt = formData.get("respectRobotsTxt") === "1";

  await setSystemSetting("scanTime", scanTime);
  await setSystemSetting("timezone", timezone);
  await setSystemSetting("closeAfterMissingScans", closeAfterMissingScans);
  await setSystemSetting("respectRobotsTxt", respectRobotsTxt);
  revalidate("/admin/settings", "/settings", "/");
  return ok();
}

export async function saveAiSettings(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireAdmin();
  const defaultModel = String(formData.get("defaultModel") ?? "").trim();
  if (!isKnownModel(defaultModel)) return fail("Choose a supported model for the default.");

  await setSystemSetting("defaultModel", defaultModel);
  revalidate("/admin/settings", "/settings");
  return ok();
}

/**
 * The per-stage model and effort routes, for every account. Administrator-only: a route overrides
 * each account's own CV model for its stage. What the form sends is checked by the engine's own
 * rules, so a model or effort the provider would refuse is refused with an error, and nothing is stored.
 */
export async function saveStageRoutes(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireAdmin();
  const parsed = stageRoutesFromForm(formData);
  if (!parsed.ok) return fail(parsed.error);
  await setSystemSetting("stageRoutes", parsed.routes);
  revalidatePath("/admin/settings");
  return ok();
}

/**
 * How background fit scoring reaches the model, for every account: live, one call per role as it
 * enters a table, or batched every few minutes through the Message Batches API at half the token
 * price, with scores arriving minutes to an hour later. Administrator-only: it changes when every
 * account's scores land and what the deployment pays for them.
 */
export async function saveScoringSettings(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireAdmin();
  const mode = String(formData.get("scoringMode") ?? "").trim();
  if (!(SCORING_MODES as readonly string[]).includes(mode)) return fail("Choose live or batch scoring.");
  const minutes = scoringBatchMinutesFrom(String(formData.get("scoringBatchMinutes") ?? "").trim());
  if (minutes === null) return fail(`Collect a batch every ${SCORING_BATCH_MINUTES_MIN} to ${SCORING_BATCH_MINUTES_MAX} minutes, in whole minutes.`);
  await setSystemSetting("scoringMode", mode);
  await setSystemSetting("scoringBatchMinutes", minutes);
  revalidatePath("/admin/settings");
  return ok();
}

/** A budget is money, so it is bounded on the way in as well as on the way out of settings. */
const AiBudgetSchema = z.coerce.number().min(0).max(MAX_ACCOUNT_AI_BUDGET_USD);

/**
 * The signed-in account's own monthly AI budget, the one budget there is. Anyone may set their
 * own; an administrator sets anyone's in Admin › Accounts, which is the same stored key, so Admin
 * is revalidated too.
 *
 * The deployment pays for the model, so a member sets theirs up to `MAX_MEMBER_AI_BUDGET_USD`, or
 * up to what an administrator granted them when that is more: a grant can be lowered here but a
 * member never raises their own budget past it. An administrator sets any figure up to the maximum.
 */
export async function saveAiBudget(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const entered = String(formData.get("aiBudgetUsd") ?? "").trim();
  const parsed = entered ? AiBudgetSchema.safeParse(entered) : null;
  if (!parsed?.success) return fail(`A monthly AI budget is a number between $0 and $${MAX_ACCOUNT_AI_BUDGET_USD}.`);
  const budget = Math.round(parsed.data * 100) / 100;
  if (user.role !== "admin") {
    const granted = (await getSettings()).aiBudgetUsd;
    const ceiling = Math.max(MAX_MEMBER_AI_BUDGET_USD, granted);
    if (budget > ceiling) {
      return fail(ceiling > MAX_MEMBER_AI_BUDGET_USD
        ? `You can set your monthly AI budget up to $${ceiling}, the budget an administrator gave you. Ask an administrator for more.`
        : `You can set your monthly AI budget up to $${MAX_MEMBER_AI_BUDGET_USD}. Ask an administrator for more.`);
    }
  }
  await setUserSetting(user.id, "aiBudgetUsd", budget);
  revalidate("/settings", "/admin");
  return ok();
}

/** One shared run for every company anyone follows. */
export async function runDailyScanNow(): Promise<void> {
  await requireAdmin();
  await enqueue("run_daily", { trigger: "manual" });
  revalidate("/admin/settings", "/admin/health", "/health");
}
