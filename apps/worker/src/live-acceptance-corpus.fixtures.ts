import type { SourceType } from "@col/core";
import type { LiveAcceptanceCase } from "./live-acceptance";

/** Synthetic structure fixture only; it is never a human-labelled posting corpus. */
export function fullyCoveredCorpus(): LiveAcceptanceCase[] {
  const ats: SourceType[] = ["greenhouse", "lever", "ashby", "workable", "smartrecruiters",
    "recruitee", "personio", "workday", "workday"];
  return Array.from({ length: 25 }, (_, index) => {
    const type = ats[index] ?? "html";
    const sourceUrl = `https://company${index}.example/jobs`;
    const evidence = { evidenceUrl: sourceUrl, checkedAt: "2026-09-29",
      note: "Synthetic independently checked corpus structure fixture; no live claim." };
    return {
      id: `company${index}`, company: `Company ${index}`, homepageUrl: `https://company${index}.example/`,
      expectedSource: { type, url: sourceUrl }, expectedRoleCount: null,
      labelStatus: "source_independently_checked", labelNote: "Synthetic source identity fixture for gate testing only.",
      sourceEvidenceUrls: [sourceUrl], sourceCheckedAt: "2026-09-29",
      coverage: {
        ...(index >= 9 && index <= 13 ? { customHtml: evidence } : {}),
        ...(index === 9 || index === 10 ? { jsHeavy: evidence } : {}),
        ...(index === 7 || index === 8 ? { multiRegionWorkday: evidence } : {}),
        ...(index === 0 ? { landingToExternalBoard: evidence } : {}),
        ...(index === 14 ? { botProtected: evidence } : {}),
      },
    };
  });
}
