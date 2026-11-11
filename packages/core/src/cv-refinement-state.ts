import type { CvRefinementV1 } from "./cv-editing-modes";

/** A saved edition may have applied choices that have since been edited or forgotten. */
export function cvRemovedAppliedRefinements(snapshot: CvRefinementV1[],
  applied: Array<{ id: string; version: number }>, current: CvRefinementV1[]): CvRefinementV1[] {
  const appliedKeys = new Set(applied.map(row => `${row.id}:${row.version}`));
  const currentKeys = new Set(current.map(row => `${row.id}:${row.version}`));
  return snapshot.filter(row => appliedKeys.has(`${row.id}:${row.version}`) &&
    !currentKeys.has(`${row.id}:${row.version}`));
}

/** Appearance and item order can be deterministically replaced or restored. */
export function cvNeedsAuthoredRebuild(removed: CvRefinementV1[]): boolean {
  return removed.some(row => row.kind !== "structured" ||
    (row.structured?.kind !== "appearance" && row.structured?.kind !== "item_order"));
}
