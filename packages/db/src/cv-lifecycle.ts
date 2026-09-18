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
type CvRole = Pick<Draft, "userId" | "companyName" | "jobTitle">;
type CompletionValues = Pick<
  Partial<typeof cvDrafts.$inferInsert>,
  "content" | "assessment" | "revision" | "buildStage" | "error"
> & { status?: "ready" };

// The same immutable expression is shared by the index, lookup and lock identity.
const roleKey = (
  role:
    | CvRole
    | {
        userId: typeof cvDrafts.userId;
        companyName: typeof cvDrafts.companyName;
        jobTitle: typeof cvDrafts.jobTitle;
      },
) => cvRoleKey(role.userId, role.companyName, role.jobTitle);
const sameRole = (role: CvRole) => sql`${roleKey(cvDrafts)} = ${roleKey(role)}`;
const metadata = {
  id: cvDrafts.id,
  userId: cvDrafts.userId,
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

/**
 * One saved CV and one archive per role, and never a pile of dead attempts beside them: the
 * retention plans keep the ready pair, and this removes the failures they leave behind — `keep`
 * is how many of the newest are still worth reopening (one while the next attempt runs, none once
 * it has published), and `spare` is a draft this particular call must not remove.
 *
 * Three kinds of failed row are deliberately out of reach. A build that is queued or generating
 * belongs to a worker holding its lease and will publish or fail on its own; a failure the user
 * archived by hand is their archive, and the plans decide that; and the draft a save is reading
 * its wording from is never pulled out from under that save.
 */
async function pruneFailedCvDrafts(
  tx: Transaction,
  role: CvRole,
  keep: number,
  spare?: string,
) {
  const failed = await tx
    .select({ id: cvDrafts.id })
    .from(cvDrafts)
    .where(
      and(sameRole(role), eq(cvDrafts.status, "failed"), isNull(cvDrafts.archivedAt)),
    )
    .orderBy(...newest);
  const obsolete = failed
    .slice(keep)
    .map((row) => row.id)
    .filter((id) => id !== spare);
  if (obsolete.length)
    await tx.delete(cvDrafts).where(inArray(cvDrafts.id, obsolete));
}

/**
 * The next version for a role, and the moment its dead attempts are cleared. `spare` is the draft
 * the new revision is being written from, which an edit passes so that saving from any failed
 * revision works: it can leave a second failed row behind, and the next publish takes it.
 */
export async function nextCvRevision(
  tx: Transaction,
  role: CvRole,
  options?: { spare?: string },
) {
  await lockCvLifecycle(tx, role);
  // Read the ledger's high-water mark before pruning, so versions keep increasing whatever goes.
  const [row] = await tx
    .select({
      revision: sql<number>`coalesce(max(${cvDrafts.revision}), 0)::int`,
    })
    .from(cvDrafts)
    .where(sameRole(role));
  // A new attempt supersedes the earlier failures; only the newest is still worth retrying, so
  // saved wording on an older one survives until something other than itself supersedes it.
  await pruneFailedCvDrafts(tx, role, 1, options?.spare);
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
  // A CV that built supersedes every failed attempt at this role, older or newer than it.
  await pruneFailedCvDrafts(tx, draft, 0);
  if (draft.archivedAt) return true;
  const rows = await tx
    .select(metadata)
    .from(cvDrafts)
    .where(sameRole(draft))
    .orderBy(...newest);
  await applyRetention(tx, completionRetention(rows, id));
  return true;
}

/** Archive, restore or delete some of one account's CVs. Ids belonging to anyone else are ignored. */
export async function actionCvs(
  database: Db,
  userId: string,
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
      .where(and(inArray(cvDrafts.id, [...selectedIds]), eq(cvDrafts.userId, userId)));
    for (const { key } of roles.sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    )) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
      );
    }
    if (action === "delete") {
      await tx.delete(cvDrafts).where(and(inArray(cvDrafts.id, [...selectedIds]), eq(cvDrafts.userId, userId)));
      return;
    }
    if (!roles.length) return;
    // One metadata query for the entire selection; never load content, evidence or assessments.
    const rows = await tx
      .select({ ...metadata, key: roleKey(cvDrafts) })
      .from(cvDrafts)
      .where(
        and(
          eq(cvDrafts.userId, userId),
          inArray(
            roleKey(cvDrafts),
            roles.map((role) => role.key),
          ),
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

/**
 * Give up on a build nothing is running any more, so the page stops saying "generating".
 *
 * A CV build is the one task a person watches while it runs, and the only thing that ever moves
 * its draft out of `queued`/`generating` is the handler itself. A worker killed mid-build — an
 * out-of-memory, a pod replaced — writes nothing, so the draft stays half-alive until someone
 * notices. This is what the queue calls when it gives up on the task: the draft fails with a
 * message that says what to do, and its stage is cleared so nothing reads a step that is not
 * running. A draft already `ready` or `failed` is left exactly as it is, and the role's lifecycle
 * lock is taken first, like every other transition here.
 *
 * Returns the account the draft belongs to, so the caller can release that account's hold for it.
 */
export async function abandonCvDraft(
  database: Db,
  id: string,
  error: string,
): Promise<{ userId: string } | null> {
  return database.transaction(async (tx) => {
    await lockCvDraft(tx, id);
    const [draft] = await tx
      .select(metadata)
      .from(cvDrafts)
      .where(eq(cvDrafts.id, id));
    if (!draft) return null;
    if (draft.status !== "queued" && draft.status !== "generating") return null;
    const rows = await tx
      .update(cvDrafts)
      .set({ status: "failed", error: error.slice(0, 1000), buildStage: null })
      .where(and(eq(cvDrafts.id, id), inArray(cvDrafts.status, ["queued", "generating"])))
      .returning({ id: cvDrafts.id });
    return rows.length ? { userId: draft.userId } : null;
  });
}
