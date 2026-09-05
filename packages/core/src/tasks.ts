/** Task types and payload shapes shared by the web app (producer) and the worker (consumer). */

export interface TaskPayloads {
  discover: { companyId: string; url?: string; reason?: "added" | "manual" | "failing" | "suspect_empty" | "pasted" };
  scan_company: { companyId: string; scanRunId?: string; trigger?: "schedule" | "manual" };
  run_daily: { trigger: "schedule" | "manual"; runDate?: string };
  fetch_description: { jobId: string };
  score_job: { jobId: string; nearMiss?: boolean };
  tag_reason: { decisionId: string };
  synthesize_profile: { force?: boolean };
  suggest_filters: Record<string, never>;
  profile_company: { companyId: string };
  suggest_companies: { limit?: number };
  rescore_all: { onlyInTable?: boolean };
  reevaluate_gate: Record<string, never>;
}

export type TaskType = keyof TaskPayloads;

export function dedupeKeyFor<T extends TaskType>(type: T, payload: TaskPayloads[T]): string | null {
  switch (type) {
    case "discover":
      return `discover:${(payload as TaskPayloads["discover"]).companyId}`;
    case "scan_company":
      return `scan_company:${(payload as TaskPayloads["scan_company"]).companyId}`;
    case "run_daily":
      return `run_daily`;
    case "fetch_description":
      return `fetch_description:${(payload as TaskPayloads["fetch_description"]).jobId}`;
    case "score_job":
      return `score_job:${(payload as TaskPayloads["score_job"]).jobId}`;
    case "tag_reason":
      return `tag_reason:${(payload as TaskPayloads["tag_reason"]).decisionId}`;
    case "synthesize_profile":
      return "synthesize_profile";
    case "suggest_filters":
      return "suggest_filters";
    case "profile_company":
      return `profile_company:${(payload as TaskPayloads["profile_company"]).companyId}`;
    case "suggest_companies":
      return "suggest_companies";
    case "rescore_all":
      return "rescore_all";
    case "reevaluate_gate":
      return "reevaluate_gate";
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
    case "profile_company":
    case "rescore_all":
      return 6;
    case "suggest_companies":
      return 7;
    default:
      return 5;
  }
}
