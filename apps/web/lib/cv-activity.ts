import type { CvActivity } from "@col/db";

export type CvActivityReading = Omit<CvActivity, "createdAt" | "updatedAt" | "completedAt" | "work"> & {
  createdAt: string; updatedAt: string; completedAt: string | null;
  phase?: "waiting" | "progressing" | "stalled" | "retrying" | "stopped" | "failed";
};
export function isCvActive(item: CvActivityReading): boolean {
  return item.status !== "ready" && item.status !== "failed";
}
export function cvActivityLabel(item: CvActivityReading): string {
  if (item.status === "ready") return "CV ready";
  if (item.status === "failed") return "CV needs attention";
  if (item.status === "awaiting_evidence" || item.status === "awaiting_priorities") return "Continue your CV";
  if (item.phase === "retrying") return "Retrying your CV";
  if (item.phase === "stalled") return "CV taking longer than expected";
  if (item.phase === "stopped" || item.phase === "failed") return "CV needs attention";
  if (item.status === "queued" || item.phase === "waiting") return "CV queued";
  return ({ analysing: "Preparing your CV", writing: "Writing your CV", fitting: "Fitting your CV", assessing: "Checking your CV", publishing: "Saving your CV" } as Record<string, string>)[item.stage ?? ""] ?? "Building your CV";
}
/** Milestones, not an estimate of elapsed time or percentage complete. */
export const CV_ACTIVITY_STAGES = ["Prepare", "Write", "Fit", "Check"] as const;
export function cvActivityStage(item: CvActivityReading): number {
  return ({ analysing: 0, writing: 1, fitting: 2, assessing: 3, publishing: 3 } as Record<string, number>)[item.stage ?? ""] ?? -1;
}
