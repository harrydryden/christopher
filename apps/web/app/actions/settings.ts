"use server";

import { needsEmailConfirmation, requireAdmin, requireUser } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isKnownModel, isValidScanTime, isValidTimezone, MAX_ACCOUNT_AI_BUDGET_USD, MAX_MEMBER_AI_BUDGET_USD, parseTermList, type GateSettings, type MatchField } from "@ava/core";
import { enqueue } from "@/lib/enqueue";
import { GATE_NEEDS_KEYWORD_SENTENCE } from "@/lib/setup";
import { getSettings, setSystemSetting, setUserSetting, saveSettingsAndGate } from "@/lib/settings";
import { stageRoutesFromForm } from "@/lib/stage-routes";
import { fail, ok, type ActionResult } from "@/lib/validation";

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
  const settings = await getSettings();
  const parsed = gateFromForm(formData, settings.gate);
  if (!parsed.ok) return fail(parsed.error);
  await saveSettingsAndGate(user.id, { gate: parsed.gate }, { rescore: !needsEmailConfirmation(user) });
  revalidatePath("/settings");
  revalidatePath("/companies");
  revalidatePath("/");
  return ok();
}

/** The Keywords card: the same save, with only the keyword fields on the form. */
export async function saveKeywords(prev: ActionResult, formData: FormData): Promise<ActionResult> {
  return saveGate(prev, formData);
}

export async function saveMatchFields(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const settings = await getSettings();
  const raw = formData.getAll("matchFields").map(String);
  const matchFields = MATCH_FIELDS.filter((f) => raw.includes(f));
  await saveSettingsAndGate(user.id, { gate: { ...settings.gate, matchFields: matchFields.length ? matchFields : ["title"] } }, { rescore: !needsEmailConfirmation(user) });
  revalidatePath("/settings");
  revalidatePath("/");
  return ok();
}

/** The Location filter card: the same save, with only the location fields on the form. */
export async function saveLocationFilter(prev: ActionResult, formData: FormData): Promise<ActionResult> {
  return saveGate(prev, formData);
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
  revalidatePath("/settings");
  revalidatePath("/");
  return ok();
}

/** Whether this account wants weekly similar-company recommendations and source checks. */
export async function saveSuggestionSettings(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  await setUserSetting(user.id, "suggestionsEnabled", formData.get("suggestionsEnabled") === "1");
  revalidatePath("/settings");
  revalidatePath("/suggestions");
  return ok();
}

/** Who may create an account: administrator addresses always can; everyone else only while this is on. */
export async function saveRegistrationSettings(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireAdmin();
  await setSystemSetting("registrationOpen", formData.get("registrationOpen") === "1");
  revalidatePath("/admin");
  revalidatePath("/signup");
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
  revalidatePath("/admin/settings");
  revalidatePath("/settings");
  revalidatePath("/");
  return ok();
}

export async function saveAiSettings(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireAdmin();
  const defaultModel = String(formData.get("defaultModel") ?? "").trim();
  if (!isKnownModel(defaultModel)) return fail("Choose a supported model for the default.");

  await setSystemSetting("defaultModel", defaultModel);
  revalidatePath("/admin/settings");
  revalidatePath("/settings");
  return ok();
}

/**
 * The per-stage model and effort routes, for every account. Administrator-only: a route overrides
 * each account's own CV model for its stage. What the form sends is sanitised by the engine's own
 * rules, so a model or effort the provider would refuse is dropped rather than stored.
 */
export async function saveStageRoutes(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireAdmin();
  await setSystemSetting("stageRoutes", stageRoutesFromForm(formData));
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
  revalidatePath("/settings");
  revalidatePath("/admin");
  return ok();
}

/** One shared run for every company anyone follows. */
export async function runDailyScanNow(): Promise<void> {
  await requireAdmin();
  await enqueue("run_daily", { trigger: "manual" });
  revalidatePath("/admin/settings");
  revalidatePath("/admin/health");
  revalidatePath("/health");
}
