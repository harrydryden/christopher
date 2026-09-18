"use server";

import { requireAdmin, requireUser } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isKnownModel, isValidScanTime, isValidTimezone, MAX_ACCOUNT_AI_BUDGET_USD, parseTermList, type MatchField } from "@christopher/core";
import { enqueue } from "@/lib/enqueue";
import { getSettings, setSystemSetting, setUserSetting, saveSettingsAndGate } from "@/lib/settings";
import { fail, ok, type ActionResult } from "@/lib/validation";

const MATCH_FIELDS: MatchField[] = ["title", "department", "description"];

export async function saveKeywords(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const settings = await getSettings();
  const includeKeywords = parseTermList(String(formData.get("includeKeywords") ?? ""));
  const excludeKeywords = parseTermList(String(formData.get("excludeKeywords") ?? ""));
  const seniorityKeywords = formData.has("seniorityKeywords") ? parseTermList(String(formData.get("seniorityKeywords") ?? "")) : settings.gate.seniorityKeywords ?? [];
  await saveSettingsAndGate(user.id, { gate: { ...settings.gate, includeKeywords, excludeKeywords, seniorityKeywords } });
  revalidatePath("/settings");
  revalidatePath("/");
  return ok();
}

export async function saveMatchFields(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const settings = await getSettings();
  const raw = formData.getAll("matchFields").map(String);
  const matchFields = MATCH_FIELDS.filter((f) => raw.includes(f));
  await saveSettingsAndGate(user.id, { gate: { ...settings.gate, matchFields: matchFields.length ? matchFields : ["title"] } });
  revalidatePath("/settings");
  revalidatePath("/");
  return ok();
}

export async function saveLocationFilter(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const settings = await getSettings();
  const locationTerms = parseTermList(String(formData.get("locationTerms") ?? ""));
  const includeRemote = formData.get("includeRemote") === "1";
  await saveSettingsAndGate(user.id, { gate: { ...settings.gate, locationTerms, includeRemote } });
  revalidatePath("/settings");
  revalidatePath("/");
  return ok();
}

/** Automatic score hiding is retired: a stored `hideThreshold` is left where it is and ignored. */
export async function saveTableSettings(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const showClosedDays = Number(formData.get("showClosedDays"));
  if (!Number.isInteger(showClosedDays) || showClosedDays < 0 || showClosedDays > 365) {
    return fail("Show-closed-days must be a whole number between 0 and 365.");
  }

  await saveSettingsAndGate(user.id, { showClosedDays });
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

/** A budget is money, so it is bounded on the way in as well as on the way out of settings. */
const AiBudgetSchema = z.coerce.number().min(0).max(MAX_ACCOUNT_AI_BUDGET_USD);

/**
 * The signed-in account's own monthly AI budget, the one budget there is. Anyone may set their
 * own; an administrator sets anyone's in Admin › Accounts, which is the same stored key, so Admin
 * is revalidated too.
 */
export async function saveAiBudget(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const entered = String(formData.get("aiBudgetUsd") ?? "").trim();
  const parsed = entered ? AiBudgetSchema.safeParse(entered) : null;
  if (!parsed?.success) return fail(`A monthly AI budget is a number between $0 and $${MAX_ACCOUNT_AI_BUDGET_USD}.`);
  await setUserSetting(user.id, "aiBudgetUsd", Math.round(parsed.data * 100) / 100);
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
