import { getLatestScanRun } from "./queries/companies";
import { getSettings } from "./settings";
import { scanBannerText } from "./scan-banner";
import { scanRunReport } from "./scan-run-report";
export async function getScanStatus() {
  const [stored, settings] = await Promise.all([getLatestScanRun(), getSettings()]);
  const run = stored ? await scanRunReport(stored) : null;
  return { text: scanBannerText(run, settings.timezone, new Date()) + (run?.historicalOnly ? " · Stored summary; source detail unavailable" : "") };
}
