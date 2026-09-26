import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { CvBuildFailure } from "@ava/core";
import type { Db } from "./client";
import { cvDrafts, cvShareComments, cvShares, cvTailoringPlans } from "./schema";
import type { CvTailoringPlan } from "@ava/core/cv-tailoring";
import { cvRoleKey } from "./cv-role-key";
import {
  archiveRetention,
  completionRetention,
  restoreRetention,
  type CvRetentionPlan,
} from "./cv-retention";

/**
 * Asked to remove a CV a worker is building.
 *
 * `userFacing` is the interface's contract for an error whose message is the person's to read: the
 * action shows it verbatim instead of its own fallback. Deleting a draft mid-build used to
 * succeed, and the build then spent the rest of its model calls writing a CV into a row that no
 * longer existed, with nothing on the page to say so.
 */
export class CvBuildInFlightError extends Error {
  readonly userFacing = true as const;
  constructor(message: string) {
    super(message);
    this.name = "CvBuildInFlightError";
  }
}

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Draft = typeof cvDrafts.$inferSelect;
type CvRole = Pick<Draft, "userId" | "companyName" | "jobTitle">;
type CompletionValues = Pick<
  Partial<typeof cvDrafts.$inferInsert>,
  // A published CV has nothing left to resume from and nothing left to explain, so publication is
  // also where the build's checkpoint and its last failure are cleared, in the same transaction.
  "content" | "assessment" | "revision" | "buildStage" | "error" | "buildCheckpoint" | "failure"
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
 * The drafts among `ids` that someone is still reading or still waiting to hear back on: a link to
 * them that is neither revoked nor expired, or a note left through one that the owner has not yet
 * resolved. Retention leaves these alone, because deleting a draft takes its links and every note
 * with it — a reviewer's feedback on the revision it was written about, lost to the owner's next
 * two edits without their doing anything. Resolving the notes and ending the links hands the
 * draft back to retention; deleting it by hand is still the owner's choice and still cascades.
 *
 * The share rows are locked, so a note being written through one of them now either lands before
 * this decides, and spares the draft, or finds the draft gone.
 */
async function sparedForReview(tx: Transaction, userId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await tx
    .select({ draftId: cvShares.draftId })
    .from(cvShares)
    .where(and(
      eq(cvShares.userId, userId),
      inArray(cvShares.draftId, ids),
      sql`((${cvShares.revokedAt} is null and ${cvShares.expiresAt} > now()) or exists (
        select 1 from ${cvShareComments}
        where ${cvShareComments.shareId} = ${cvShares.id} and ${cvShareComments.userId} = ${userId}
          and ${cvShareComments.resolvedAt} is null))`,
    ))
    .for("update");
  return new Set(rows.map(row => row.draftId));
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
  const candidates = failed
    .slice(keep)
    .map((row) => row.id)
    .filter((id) => id !== spare);
  const spared = await sparedForReview(tx, role.userId, candidates);
  const obsolete = candidates.filter((id) => !spared.has(id));
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

async function applyRetention(tx: Transaction, userId: string, plan: CvRetentionPlan) {
  // A revision someone is still reviewing is archived instead of deleted: it stays out of the
  // way of the role's current CV, and keeps its links and notes until they are done with.
  const spared = await sparedForReview(tx, userId, plan.deleteIds);
  const deleteIds = plan.deleteIds.filter((id) => !spared.has(id));
  if (deleteIds.length)
    await tx.delete(cvDrafts).where(inArray(cvDrafts.id, deleteIds));
  if (spared.size)
    await tx
      .update(cvDrafts)
      .set({ archivedAt: new Date() })
      .where(and(inArray(cvDrafts.id, [...spared]), isNull(cvDrafts.archivedAt)));
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
  await applyRetention(tx, draft.userId, completionRetention(rows, id));
  return true;
}

/**
 * Archive, restore or delete some of one account's CVs. Ids belonging to anyone else are ignored.
 *
 * A build a worker is running is left alone: archiving it is skipped, because the retention plan
 * it takes part in would decide the fate of a draft that is still being written, and deleting it
 * is refused outright, because the build would carry on spending the account's budget on a row
 * that had gone. A queued build nothing has claimed yet is still the person's to archive, which is
 * how a replacement is asked for and archived in one motion.
 */
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
    // Which of them a worker is building is read only now, behind the role locks, and with the
    // selected rows themselves locked. A worker starting a queued build moves it to generating
    // with a plain row update, which takes no role lock: read before the locks, a build could
    // start between the read and the delete, and its model calls were paid for on a row that went.
    // Locked here, that update waits for this transaction, and then finds the row gone — before it
    // spends anything — or it came first, and the build is seen and refused.
    const selected = await tx
      .select({ id: cvDrafts.id, status: cvDrafts.status })
      .from(cvDrafts)
      .where(and(inArray(cvDrafts.id, [...selectedIds]), eq(cvDrafts.userId, userId)))
      .orderBy(cvDrafts.id)
      .for("update");
    const building = selected.filter((row) => row.status === "generating");
    if (action === "delete" && building.length)
      throw new CvBuildInFlightError(
        building.length === 1
          ? "This CV is still being built. Wait for the build to finish or fail, then delete it."
          : `${building.length} of the selected CVs are still being built. Wait for those builds to finish or fail, then delete them.`,
      );
    // Archiving is what runs a retention plan over the role, so a build in flight is left out of
    // the selection it decides. Restoring one is harmless — it moves that draft's own marker and
    // nothing else — and the plans can no longer delete an in-flight row whatever the action.
    if (action === "archive") for (const row of building) selectedIds.delete(row.id);
    if (!selectedIds.size) return;
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
      if (plan) await applyRetention(tx, userId, plan);
    }
  });
}

/**
 * Record why this attempt stopped on a draft that is still building, without ending the build.
 *
 * The queue writes this when a handler outruns its deadline and there are attempts left: the draft
 * stays `generating`, because the queue is bringing it back, and the failure says which attempt
 * stopped, what stopped it and when the next one runs. Without it the page went on saying
 * "progressing" for the rest of the day, because the worker that would have written the failure
 * was the one that had been given up on.
 *
 * Returns false when the draft has since finished, failed or gone: a late write must not overwrite
 * the outcome of an attempt that got there first.
 */
export async function noteCvBuildFailure(
  database: Db,
  id: string,
  failure: CvBuildFailure,
): Promise<boolean> {
  const rows = await database
    .update(cvDrafts)
    .set({ failure })
    .where(and(eq(cvDrafts.id, id), inArray(cvDrafts.status, ["queued", "generating"])))
    .returning({ id: cvDrafts.id });
  return rows.length > 0;
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
  /**
   * The same event in the taxonomy the page reads. Without it an interrupted build was the one
   * failure with no kind and no next step: the narrative showed a bare sentence where every other
   * failure named what had happened and whose move it was.
   */
  failure?: CvBuildFailure,
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
      .set({ status: "failed", error: error.slice(0, 1000), buildStage: null, ...(failure ? { failure } : {}) })
      .where(and(eq(cvDrafts.id, id), inArray(cvDrafts.status, ["queued", "generating"])))
      .returning({ id: cvDrafts.id });
    return rows.length ? { userId: draft.userId } : null;
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The name a revision goes by on the page: its UTC creation day and daily version, "26-Sep-V3". */
export function cvRevisionName(createdAt: Date, version: number): string {
  return `${String(createdAt.getUTCDate()).padStart(2, "0")}-${MONTHS[createdAt.getUTCMonth()]}-V${version}`;
}

/** What adopting an improvement came to: the revision it saved, or why the original was kept. */
export type CvImprovedRevision =
  | { adopted: true; id: string; revision: number; version: number; name: string }
  | { adopted: false; reason: string };

/**
 * Save a build's stronger candidate as a new revision of the baseline it improved, the way a
 * Rebuild saves one: the next revision number for the role, `parentId` on the baseline, published
 * through the same completion and retention as any build, so the baseline becomes the role's
 * archive and the improvement its current CV.
 *
 * The baseline was published before the improvement was attempted, so the person may have moved
 * on in the meantime. The improvement is adopted only while the baseline is still the role's
 * current CV — ready, not archived, and with no newer revision started since — and never over
 * something they have done: a Rebuild or an edit they asked for wins over optional polish. Runs in
 * the caller's transaction, behind its fence, under the role's lifecycle lock.
 */
/**
 * Keep the plan a published CV was written against beside it, for replay. One per draft; the
 * account is named so nothing reads a plan without its owner. Inside the caller's transaction.
 */
export async function saveCvTailoringPlan(tx: Pick<Db, "insert">, draftId: string, userId: string, plan: CvTailoringPlan): Promise<void> {
  await tx.insert(cvTailoringPlans).values({ draftId, userId, plan })
    .onConflictDoUpdate({ target: cvTailoringPlans.draftId, set: { plan } });
}

export async function saveImprovedCvRevision(
  tx: Transaction,
  baselineId: string,
  values: Pick<typeof cvDrafts.$inferInsert, "content" | "assessment">,
  tailoringPlan?: CvTailoringPlan,
): Promise<CvImprovedRevision> {
  await lockCvDraft(tx, baselineId);
  const [baseline] = await tx.select().from(cvDrafts).where(eq(cvDrafts.id, baselineId));
  if (!baseline) return { adopted: false, reason: "the CV was deleted before the stronger revision was ready" };
  if (baseline.status !== "ready" || baseline.archivedAt)
    return { adopted: false, reason: "the CV was archived before the stronger revision was ready" };
  const [newer] = await tx.select({ id: cvDrafts.id }).from(cvDrafts).where(and(
    sameRole(baseline), ne(cvDrafts.id, baseline.id), sql`${cvDrafts.createdAt} > ${baseline.createdAt}`, ne(cvDrafts.status, "failed"),
  )).limit(1);
  if (newer) return { adopted: false, reason: "a newer revision of this CV was started before the stronger revision was ready" };
  const revision = await nextCvRevision(tx, baseline, { spare: baseline.id });
  const [row] = await tx.insert(cvDrafts).values({
    userId: baseline.userId, jobId: baseline.jobId, jobTitle: baseline.jobTitle, companyName: baseline.companyName,
    jobDescription: baseline.jobDescription, jobSource: baseline.jobSource, libraryVersion: baseline.libraryVersion,
    librarySnapshot: baseline.librarySnapshot, model: baseline.model, status: "generating", revision,
    parentId: baseline.id, ...values,
  }).returning({ id: cvDrafts.id, createdAt: cvDrafts.createdAt });
  await completeCv(tx, row!.id, { status: "ready", revision, buildStage: null, buildCheckpoint: null, failure: null });
  if (tailoringPlan) await saveCvTailoringPlan(tx, row!.id, baseline.userId, tailoringPlan);
  const version = await tx.execute<{ version: number }>(sql`select version from cv_versions where cv_id = ${row!.id}`);
  const daily = Number(version.rows[0]?.version ?? revision);
  return { adopted: true, id: row!.id, revision, version: daily, name: cvRevisionName(row!.createdAt, daily) };
}
