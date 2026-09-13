import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./client";
import { cvDrafts } from "./schema";
import { cvRoleKey } from "./cv-role-key";
import {
  archiveRetention,
  completionRetention,
  restoreRetention,
  type CvRetentionPlan,
} from "./cv-retention";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Draft = typeof cvDrafts.$inferSelect;
type CvRole = Pick<Draft, "companyName" | "jobTitle">;
type CompletionValues = Pick<
  Partial<typeof cvDrafts.$inferInsert>,
  "content" | "assessment" | "revision" | "buildStage" | "error"
> & { status?: "ready" };

// The same immutable expression is shared by the index, lookup and lock identity.
const roleKey = (
  role:
    | CvRole
    | {
        companyName: typeof cvDrafts.companyName;
        jobTitle: typeof cvDrafts.jobTitle;
      },
) => cvRoleKey(role.companyName, role.jobTitle);
const sameRole = (role: CvRole) => sql`${roleKey(cvDrafts)} = ${roleKey(role)}`;
const metadata = {
  id: cvDrafts.id,
  companyName: cvDrafts.companyName,
  jobTitle: cvDrafts.jobTitle,
  status: cvDrafts.status,
  archivedAt: cvDrafts.archivedAt,
};
const newest = [desc(cvDrafts.createdAt), desc(cvDrafts.id)];

/** Unrelated roles can progress independently; the lock lasts only for the transaction. */
async function lockLegacyLifecycle(tx: Transaction) {
  // Compatible with an older worker's exclusive lock during a rolling deployment.
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(hashtext('cv:lifecycle'))`,
  );
}
export async function lockCvLifecycle(tx: Transaction, role: CvRole) {
  await lockLegacyLifecycle(tx);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${roleKey(role)}, 0))`,
  );
}

/** Lock before taking row locks, consistently with publication and bulk actions. */
export async function lockCvDraft(tx: Transaction, id: string) {
  const [row] = await tx
    .select(metadata)
    .from(cvDrafts)
    .where(eq(cvDrafts.id, id));
  if (row) await lockCvLifecycle(tx, row);
}

export async function nextCvRevision(tx: Transaction, role: CvRole) {
  await lockCvLifecycle(tx, role);
  const [row] = await tx
    .select({
      revision: sql<number>`coalesce(max(${cvDrafts.revision}), 0)::int`,
    })
    .from(cvDrafts)
    .where(sameRole(role));
  return (row?.revision ?? 0) + 1;
}

async function applyRetention(tx: Transaction, plan: CvRetentionPlan) {
  if (plan.deleteIds.length)
    await tx.delete(cvDrafts).where(inArray(cvDrafts.id, plan.deleteIds));
  // Preserve the time of an existing archive when an older build merely completes late.
  if (plan.archiveId)
    await tx
      .update(cvDrafts)
      .set({ archivedAt: new Date() })
      .where(and(eq(cvDrafts.id, plan.archiveId), isNull(cvDrafts.archivedAt)));
  if (plan.currentId)
    await tx
      .update(cvDrafts)
      .set({ archivedAt: null })
      .where(eq(cvDrafts.id, plan.currentId));
}

/** Publication and retention are atomic and run behind the worker's lease fence. */
export async function completeCv(
  tx: Transaction,
  id: string,
  values: CompletionValues,
) {
  await lockCvDraft(tx, id);
  const [draft] = await tx
    .select(metadata)
    .from(cvDrafts)
    .where(eq(cvDrafts.id, id));
  if (!draft) return false;
  if (draft.status === "ready") return true; // Duplicate delivery must not change a user's archive choice.
  await tx
    .update(cvDrafts)
    .set({ ...values, status: "ready" })
    .where(eq(cvDrafts.id, id));
  if (draft.archivedAt) return true;
  const rows = await tx
    .select(metadata)
    .from(cvDrafts)
    .where(sameRole(draft))
    .orderBy(...newest);
  await applyRetention(tx, completionRetention(rows, id));
  return true;
}

export async function actionCvs(
  database: Db,
  ids: string[],
  action: "archive" | "restore" | "delete",
) {
  if (!ids.length) return;
  const selectedIds = new Set(ids);
  await database.transaction(async (tx) => {
    await lockLegacyLifecycle(tx);
    // Lock all affected roles in a stable order, preventing crossed bulk requests deadlocking.
    const roles = await tx
      .selectDistinct({ key: roleKey(cvDrafts) })
      .from(cvDrafts)
      .where(inArray(cvDrafts.id, [...selectedIds]));
    for (const { key } of roles.sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    )) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
      );
    }
    if (action === "delete") {
      await tx.delete(cvDrafts).where(inArray(cvDrafts.id, [...selectedIds]));
      return;
    }
    if (!roles.length) return;
    // One metadata query for the entire selection; never load content, evidence or assessments.
    const rows = await tx
      .select({ ...metadata, key: roleKey(cvDrafts) })
      .from(cvDrafts)
      .where(
        inArray(
          roleKey(cvDrafts),
          roles.map((role) => role.key),
        ),
      )
      .orderBy(...newest);
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = groups.get(row.key);
      if (group) group.push(row);
      else groups.set(row.key, [row]);
    }
    for (const group of groups.values()) {
      const plan =
        action === "archive"
          ? archiveRetention(group, selectedIds)
          : restoreRetention(group, selectedIds);
      if (plan) await applyRetention(tx, plan);
    }
  });
}
