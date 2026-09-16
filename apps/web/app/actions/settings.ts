"use server";

import { requireAdmin, requireUser } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { isKnownModel, isValidScanTime, isValidTimezone, parseTermList, type MatchField } from "@christopher/core";
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

export async function saveTableSettings(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const hideThresholdRaw = String(formData.get("hideThreshold") ?? "").trim();
  let hideThreshold: number | null = null;
  if (hideThresholdRaw !== "") {
    const n = Number(hideThresholdRaw);
    if (!Number.isFinite(n) || n < 0 || n > 100) return fail("Hide threshold must be a number between 0 and 100, or blank to turn it off.");
    hideThreshold = Math.round(n);
  }

  const showClosedDays = Number(formData.get("showClosedDays"));
  if (!Number.isInteger(showClosedDays) || showClosedDays < 0 || showClosedDays > 365) {
    return fail("Show-closed-days must be a whole number between 0 and 365.");
  }

  await saveSettingsAndGate(user.id, { hideThreshold, showClosedDays });
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
  revalidatePath("/settings");
  revalidatePath("/");
  return ok();
}

export async function saveAiSettings(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireAdmin();
  const defaultModel = String(formData.get("defaultModel") ?? "").trim();
  if (!isKnownModel(defaultModel)) return fail("Choose a supported model for the default.");

  const monthlyAiBudgetUsd = Number(formData.get("monthlyAiBudgetUsd"));
  if (!Number.isFinite(monthlyAiBudgetUsd) || monthlyAiBudgetUsd < 0) return fail("Monthly AI budget must be a non-negative number.");

  await setSystemSetting("defaultModel", defaultModel);
  await setSystemSetting("monthlyAiBudgetUsd", monthlyAiBudgetUsd);
  revalidatePath("/settings");
  return ok();
}

/** One shared run for every company anyone follows. */
export async function runDailyScanNow(): Promise<void> {
  await requireAdmin();
  await enqueue("run_daily", { trigger: "manual" });
  revalidatePath("/settings");
  revalidatePath("/health");
}
