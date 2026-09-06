"use server";

import { requireSession } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { isValidScanTime, isValidTimezone, parseTermList, type MatchField } from "@christopher/core";
import { enqueue } from "@/lib/enqueue";
import { getSettings, setSetting, saveSettingsAndGate } from "@/lib/settings";
import { fail, ok, type ActionResult } from "@/lib/validation";

const MATCH_FIELDS: MatchField[] = ["title", "department", "description"];

export async function saveKeywords(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireSession();
  const settings = await getSettings();
  const includeKeywords = parseTermList(String(formData.get("includeKeywords") ?? ""));
  const excludeKeywords = parseTermList(String(formData.get("excludeKeywords") ?? ""));
  const seniorityKeywords = formData.has("seniorityKeywords") ? parseTermList(String(formData.get("seniorityKeywords") ?? "")) : settings.gate.seniorityKeywords ?? [];
  await saveSettingsAndGate({ gate: { ...settings.gate, includeKeywords, excludeKeywords, seniorityKeywords } });
  revalidatePath("/settings");
  revalidatePath("/");
  return ok();
}

export async function saveMatchFields(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireSession();
  const settings = await getSettings();
  const raw = formData.getAll("matchFields").map(String);
  const matchFields = MATCH_FIELDS.filter((f) => raw.includes(f));
  await saveSettingsAndGate({ gate: { ...settings.gate, matchFields: matchFields.length ? matchFields : ["title"] } });
  revalidatePath("/settings");
  revalidatePath("/");
  return ok();
}

export async function saveLocationFilter(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireSession();
  const settings = await getSettings();
  const locationTerms = parseTermList(String(formData.get("locationTerms") ?? ""));
  const includeRemote = formData.get("includeRemote") === "1";
  await saveSettingsAndGate({ gate: { ...settings.gate, locationTerms, includeRemote } });
  revalidatePath("/settings");
  revalidatePath("/");
  return ok();
}

export async function saveTableSettings(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireSession();
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

  const nearMissEnabled = formData.get("nearMissEnabled") === "1";

  const nearMissDailyCap = Number(formData.get("nearMissDailyCap"));
  if (!Number.isInteger(nearMissDailyCap) || nearMissDailyCap < 0 || nearMissDailyCap > 100) {
    return fail("Near-miss daily cap must be a whole number between 0 and 100.");
  }

  const nearMissMinScore = Number(formData.get("nearMissMinScore"));
  if (!Number.isInteger(nearMissMinScore) || nearMissMinScore < 0 || nearMissMinScore > 100) {
    return fail("Near-miss minimum score must be a whole number between 0 and 100.");
  }

  await setSetting("hideThreshold", hideThreshold);
  await setSetting("showClosedDays", showClosedDays);
  await setSetting("nearMissEnabled", nearMissEnabled);
  await setSetting("nearMissDailyCap", nearMissDailyCap);
  await saveSettingsAndGate({ nearMissMinScore });
  revalidatePath("/settings");
  revalidatePath("/");
  return ok();
}

export async function saveSchedule(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireSession();
  const scanTime = String(formData.get("scanTime") ?? "").trim();
  if (!isValidScanTime(scanTime)) return fail("Scan time must be in HH:MM 24-hour format, e.g. 06:00.");

  const timezone = String(formData.get("timezone") ?? "").trim();
  if (!isValidTimezone(timezone)) return fail("Not a recognised timezone. Use an IANA name, e.g. Europe/London.");

  const closeAfterMissingScans = Number(formData.get("closeAfterMissingScans"));
  if (!Number.isInteger(closeAfterMissingScans) || closeAfterMissingScans < 2 || closeAfterMissingScans > 5) {
    return fail("Close-after-missing-scans must be a whole number between 2 and 5.");
  }

  const respectRobotsTxt = formData.get("respectRobotsTxt") === "1";

  await setSetting("scanTime", scanTime);
  await setSetting("timezone", timezone);
  await setSetting("closeAfterMissingScans", closeAfterMissingScans);
  await setSetting("respectRobotsTxt", respectRobotsTxt);
  revalidatePath("/settings");
  revalidatePath("/");
  return ok();
}

export async function saveAiSettings(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireSession();
  const defaultModel = String(formData.get("defaultModel") ?? "").trim();
  if (!defaultModel) return fail("Default model cannot be blank.");

  const monthlyAiBudgetUsd = Number(formData.get("monthlyAiBudgetUsd"));
  if (!Number.isFinite(monthlyAiBudgetUsd) || monthlyAiBudgetUsd < 0) return fail("Monthly AI budget must be a non-negative number.");

  const suggestionsEnabled = formData.get("suggestionsEnabled") === "1";

  await setSetting("defaultModel", defaultModel);
  await setSetting("monthlyAiBudgetUsd", monthlyAiBudgetUsd);
  await setSetting("suggestionsEnabled", suggestionsEnabled);
  revalidatePath("/settings");
  return ok();
}

export async function runDailyScanNow(): Promise<void> {
  await requireSession();
  await enqueue("run_daily", { trigger: "manual" });
  revalidatePath("/settings");
  revalidatePath("/health");
}
