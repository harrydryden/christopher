import type { CvActivity } from "@col/db";
import { cvBuildState } from "./cv-build-state";
import type { CvActivityReading } from "./cv-activity";

/** Resolve operational state on the server. Provider errors never enter the account feed. */
export function serialiseCvActivities(items: CvActivity[], now = new Date()): CvActivityReading[] {
  return items.map(({ work, ...item }) => ({ ...item,
    createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString(), completedAt: item.completedAt?.toISOString() ?? null,
    ...(work ? { phase: cvBuildState({ status: item.status, buildStage: item.stage, createdAt: item.createdAt,
      progressAt: work.progressAt, failure: work.failure, error: work.error }, work.task, now).phase } : {}),
  }));
}
