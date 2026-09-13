/** Pure retention decisions; callers supply metadata in newest-created order. */
export type CvRetentionRow = {
  id: string;
  status: "queued" | "generating" | "ready" | "failed";
  archivedAt: Date | null;
};
export type CvRetentionPlan = {
  currentId?: string;
  archiveId?: string;
  deleteIds: string[];
};

function plan(
  rows: CvRetentionRow[],
  currentId?: string,
  archiveId?: string,
  additionallyObsolete = new Set<string>(),
): CvRetentionPlan {
  return {
    currentId,
    archiveId,
    deleteIds: rows
      .filter(
        (row) =>
          row.id !== currentId &&
          row.id !== archiveId &&
          (row.status === "ready" ||
            row.archivedAt ||
            additionallyObsolete.has(row.id)),
      )
      .map((row) => row.id),
  };
}

export function completionRetention(
  rows: CvRetentionRow[],
  completedId: string,
): CvRetentionPlan {
  const ready = rows.filter((row) => row.status === "ready" && !row.archivedAt);
  const current = ready[0];
  if (!current) throw new Error("Completed CV is missing from its role group");
  const predecessor = ready.find((row) => row.id !== current.id);
  const archive =
    current.id === completedId && predecessor
      ? predecessor
      : rows.find(
          (row) =>
            row.id !== current.id && (row.status === "ready" || row.archivedAt),
        );
  return plan(rows, current.id, archive?.id);
}

export function archiveRetention(
  rows: CvRetentionRow[],
  selectedIds: Set<string>,
): CvRetentionPlan | undefined {
  const target = rows.find((row) => selectedIds.has(row.id) && !row.archivedAt);
  if (!target) return;
  const current = rows.find(
    (row) =>
      row.status === "ready" && !row.archivedAt && !selectedIds.has(row.id),
  );
  return plan(rows, current?.id, target.id, selectedIds);
}

export function restoreRetention(
  rows: CvRetentionRow[],
  selectedIds: Set<string>,
): CvRetentionPlan | undefined {
  const target = rows.find((row) => selectedIds.has(row.id) && row.archivedAt);
  if (!target) return;
  if (target.status !== "ready") return { currentId: target.id, deleteIds: [] };
  const current = rows.find((row) => row.status === "ready" && !row.archivedAt);
  return plan(rows, target.id, current?.id);
}
