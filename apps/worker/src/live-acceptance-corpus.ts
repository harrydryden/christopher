import type { SourceType } from "@ava/core";
import type { LiveAcceptanceCase } from "./live-acceptance";

/** Evidence that a reviewer checked one SPEC §9 corpus stratum, separate from a posting label. */
export interface CorpusCoverageEvidence {
  evidenceUrl: string;
  checkedAt: string;
  note: string;
}

const ATS_TYPES: ReadonlySet<SourceType> = new Set([
  "greenhouse", "lever", "ashby", "workable", "smartrecruiters", "recruitee", "personio",
  "bamboohr", "workday", "pinpoint", "breezy", "teamtailor", "icims", "jobvite",
  "jazzhr", "rippling", "successfactors", "eightfold",
]);
const STRATA = ["customHtml", "jsHeavy", "multiRegionWorkday", "landingToExternalBoard", "botProtected"] as const;
type Stratum = typeof STRATA[number];

export interface LiveAcceptanceCorpusCoverage {
  /** This reports corpus composition alone, not a pass of extraction or all of SPEC §9. */
  qualifies: boolean;
  criterionScope: string;
  counts: {
    selectedCases: number;
    distinctCompanies: number;
    primaryHtml: number;
    customHtml: number;
    jsHeavy: number;
    multiRegionWorkday: number;
    landingToExternalBoard: number;
    botProtected: number;
  };
  atsTypes: string[];
  invalidEvidence: string[];
  missingReasons: string[];
}

function realDate(value: unknown, today: string): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value > today) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function evidenceUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

function sourceEvidenceValid(item: LiveAcceptanceCase, today: string): boolean {
  return item.labelStatus === "source_independently_checked"
    && evidenceUrl(item.expectedSource.url)
    && realDate(item.sourceCheckedAt, today)
    && typeof item.labelNote === "string" && item.labelNote.trim().length >= 20
    && Array.isArray(item.sourceEvidenceUrls) && item.sourceEvidenceUrls.length > 0
    && item.sourceEvidenceUrls.every(evidenceUrl);
}

function stratumEvidenceValid(item: LiveAcceptanceCase, stratum: Stratum, today: string): boolean {
  const evidence = item.coverage?.[stratum];
  if (!evidence || !evidenceUrl(evidence.evidenceUrl) || !realDate(evidence.checkedAt, today)
    || typeof evidence.note !== "string" || evidence.note.trim().length < 20
    || !item.sourceEvidenceUrls?.includes(evidence.evidenceUrl)) return false;
  if (stratum === "customHtml" && item.expectedSource.type !== "html") return false;
  if (stratum === "multiRegionWorkday" && item.expectedSource.type !== "workday") return false;
  return true;
}

function companyHost(value: string): string | null {
  try {
    const url = new URL(value);
    if (!evidenceUrl(value)) return null;
    return url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  } catch { return null; }
}

/** Structural golden-set gate; this performs no network requests and makes no posting-quality claim. */
export function assessLiveAcceptanceCorpus(cases: LiveAcceptanceCase[], now: Date = new Date()): LiveAcceptanceCorpusCoverage {
  if (!Number.isFinite(now.getTime())) throw new Error("corpus coverage clock must be a valid date");
  const today = now.toISOString().slice(0, 10);
  const ids = new Set<string>(), names = new Set<string>(), hosts = new Set<string>();
  const atsTypes = new Set<string>();
  const invalidEvidence: string[] = [];
  const counts = { selectedCases: cases.length, distinctCompanies: 0, primaryHtml: 0, customHtml: 0,
    jsHeavy: 0, multiRegionWorkday: 0, landingToExternalBoard: 0, botProtected: 0 };
  for (const item of cases) {
    const name = item.company.trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
    const host = companyHost(item.homepageUrl);
    const duplicate = ids.has(item.id) || names.has(name) || (host !== null && hosts.has(host));
    if (ids.has(item.id)) invalidEvidence.push(`${item.id}: duplicate case ID`);
    if (!name) invalidEvidence.push(`${item.id}: company name is missing`);
    else if (names.has(name)) invalidEvidence.push(`${item.id}: duplicate company name`);
    if (!host) invalidEvidence.push(`${item.id}: valid company homepage URL is missing`);
    else if (hosts.has(host)) invalidEvidence.push(`${item.id}: duplicate company homepage host`);
    ids.add(item.id);
    if (name) names.add(name);
    if (host) hosts.add(host);
    if (duplicate || !name || !host) continue;
    counts.distinctCompanies++;
    if (!sourceEvidenceValid(item, today)) {
      invalidEvidence.push(`${item.id}: independently checked source needs a real date, cited URL and substantive note`);
      continue;
    }
    if (item.expectedSource.type === "html") counts.primaryHtml++;
    if (ATS_TYPES.has(item.expectedSource.type)) atsTypes.add(item.expectedSource.type);
    for (const stratum of STRATA) {
      if (item.coverage?.[stratum] === undefined) continue;
      if (!stratumEvidenceValid(item, stratum, today)) invalidEvidence.push(`${item.id}: ${stratum} needs cited, dated and substantive evidence for its primary source type`);
      else counts[stratum]++;
    }
  }
  const missingReasons = [...invalidEvidence];
  if (atsTypes.size < 8) missingReasons.push(`golden-set corpus has ${atsTypes.size} independently checked primary ATS types; at least 8 are required`);
  if (counts.customHtml < 5) missingReasons.push(`golden-set corpus has ${counts.customHtml} evidenced custom HTML cases; at least 5 are required`);
  if (counts.jsHeavy < 2) missingReasons.push(`golden-set corpus has ${counts.jsHeavy} evidenced JavaScript-heavy cases; at least 2 are required`);
  if (counts.multiRegionWorkday < 2) missingReasons.push(`golden-set corpus has ${counts.multiRegionWorkday} evidenced multi-region Workday companies; at least 2 are required`);
  if (counts.landingToExternalBoard < 1) missingReasons.push("golden-set corpus lacks an evidenced careers landing-to-external-board hop");
  if (counts.botProtected < 1) missingReasons.push("golden-set corpus lacks an evidenced bot-protected site");
  return {
    qualifies: missingReasons.length === 0,
    criterionScope: "SPEC §9 golden-set composition only; automatic source choice, manual resolution, posting accuracy, recipe reproduction, cost and operations require separate evidence",
    counts, atsTypes: [...atsTypes].sort(), invalidEvidence, missingReasons,
  };
}
