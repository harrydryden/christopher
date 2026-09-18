/**
 * Task types and payload shapes shared by the web app (producer) and the worker (consumer).
 *
 * Shared work (discovery, scans, the daily run, description snapshots, company profiles) carries
 * no user: it runs once for everyone who follows the company. Per-account work names its
 * `userId`, or reaches the account through the row it works on (a decision, a CV draft, a
 * discovery source, a candidate), and its dedupe key is scoped the same way.
 */

export interface TaskPayloads {
  extract_document: { sourceId: string; documentId: string };
  verify_company: { sourceId?: string; candidateId: string };
  monitor_source: { sourceId: string };
  generate_cv: { draftId: string };
  discover: { companyId: string; logoOnly?: boolean; homepageUrl?: string; url?: string; reason?: "added" | "manual" | "failing" | "suspect_empty" | "shrunk" | "pasted" };
  scan_company: { companyId: string; scanRunId?: string; trigger?: "schedule" | "manual" };
  run_daily: { trigger: "schedule" | "manual"; runDate?: string };
  fetch_description: { jobId: string };
  score_job: { userId: string; jobId: string };
  tag_reason: { decisionId: string };
  synthesize_profile: { userId: string; force?: boolean };
  suggest_filters: { userId: string };
  suggest_from_scans: { userId: string };
  profile_company: { companyId: string };
  suggest_companies: { userId: string; limit?: number };
  rescore_all: { userId: string; onlyInTable?: boolean };
  /** Without a `userId` every account is re-evaluated; `companyId` narrows it to one company's postings. */
  reevaluate_gate: { userId?: string; companyId?: string };
}

export type TaskType = keyof TaskPayloads;

export function dedupeKeyFor<T extends TaskType>(type: T, payload: TaskPayloads[T]): string | null {
  switch (type) {
    case "extract_document": return `extract_document:${(payload as TaskPayloads["extract_document"]).documentId}`;
    case "verify_company": return `verify_company:${(payload as TaskPayloads["verify_company"]).candidateId}`;
    case "monitor_source": return `monitor_source:${(payload as TaskPayloads["monitor_source"]).sourceId}`;
    case "generate_cv": return `generate_cv:${(payload as TaskPayloads["generate_cv"]).draftId}`;
    case "discover":
      { const p = payload as TaskPayloads["discover"];
        return p.logoOnly ? `company_logo:${p.companyId}:${p.homepageUrl}` : `discover:${p.companyId}`; }
    case "scan_company":
      return `scan_company:${(payload as TaskPayloads["scan_company"]).companyId}`;
    case "run_daily":
      return `run_daily`;
    case "fetch_description":
      return `fetch_description:${(payload as TaskPayloads["fetch_description"]).jobId}`;
    case "score_job":
      { const p = payload as TaskPayloads["score_job"]; return `score_job:${p.userId}:${p.jobId}`; }
    case "tag_reason":
      return `tag_reason:${(payload as TaskPayloads["tag_reason"]).decisionId}`;
    case "synthesize_profile":
      return `synthesize_profile:${(payload as TaskPayloads["synthesize_profile"]).userId}`;
    case "suggest_filters":
      return `suggest_filters:${(payload as TaskPayloads["suggest_filters"]).userId}`;
    case "suggest_from_scans":
      return `suggest_from_scans:${(payload as TaskPayloads["suggest_from_scans"]).userId}`;
    case "profile_company":
      return `profile_company:${(payload as TaskPayloads["profile_company"]).companyId}`;
    case "suggest_companies":
      return `suggest_companies:${(payload as TaskPayloads["suggest_companies"]).userId}`;
    case "rescore_all":
      return `rescore_all:${(payload as TaskPayloads["rescore_all"]).userId}`;
    case "reevaluate_gate":
      { const p = payload as TaskPayloads["reevaluate_gate"];
        return `reevaluate_gate:${p.userId ?? "all"}${p.companyId ? `:${p.companyId}` : ""}`; }
    default:
      return null;
  }
}

/** Lower runs first. Interactive tasks jump the queue. */
export function priorityFor(type: TaskType): number {
  switch (type) {
    case "discover":
    case "tag_reason":
    case "reevaluate_gate":
      return 1;
    case "fetch_description":
    case "score_job":
      return 4;
    case "scan_company":
    case "run_daily":
      return 5;
    case "synthesize_profile":
    case "suggest_filters":
    case "suggest_from_scans":
    case "profile_company":
    case "rescore_all":
      return 6;
    case "suggest_companies":
      return 7;
    default:
      return 5;
  }
}
