import { getLatestScanRun } from "./queries/companies";
import { getSystemSettings } from "./settings";
import { scanBannerText } from "./scan-banner";
import { scanRunReport } from "./scan-run-report";

/** The shared daily run, counted for one account's companies. */
export async function getScanStatus(userId: string) {
  const [stored, settings] = await Promise.all([getLatestScanRun(), getSystemSettings()]);
  const run = stored ? await scanRunReport(stored, userId) : null;
  return { text: scanBannerText(run, settings.timezone, new Date()) + (run?.historicalOnly ? " · Stored summary; source detail unavailable" : "") };
}
