import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./client";
import { cvDrafts } from "./schema";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Draft = typeof cvDrafts.$inferSelect;

/** Serialises short CV state changes, including builds finishing out of order. */
export async function lockCvLifecycle(tx: Transaction) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('cv:lifecycle'))`);
}
const normalise = (value: unknown) =>
  sql`lower(btrim(regexp_replace(${value}, '[[:space:]]+', ' ', 'g')))`;
const sameRole = (draft: Pick<Draft, "companyName" | "jobTitle">) =>
  and(
    sql`${normalise(cvDrafts.companyName)} = ${normalise(draft.companyName)}`,
    sql`${normalise(cvDrafts.jobTitle)} = ${normalise(draft.jobTitle)}`,
  );

export async function nextCvRevision(
  tx: Transaction,
  role: Pick<Draft, "companyName" | "jobTitle">,
) {
  await lockCvLifecycle(tx);
  const [row] = await tx
    .select({
      revision: sql<number>`coalesce(max(${cvDrafts.revision}), 0)::int`,
    })
    .from(cvDrafts)
    .where(sameRole(role));
  return (row?.revision ?? 0) + 1;
}

/** Keep the explicitly chosen current CV, and only its latest archived predecessor. */
async function retain(
  tx: Transaction,
  role: Draft,
  currentId?: string,
  archiveId?: string,
) {
  const rows = await tx
    .select()
    .from(cvDrafts)
    .where(sameRole(role))
    .orderBy(desc(cvDrafts.createdAt), desc(cvDrafts.id));
  const obsolete = rows.filter(
    (row) =>
      (row.archivedAt || row.status === "ready") &&
      row.id !== currentId &&
      row.id !== archiveId,
  );
  if (obsolete.length)
    await tx.delete(cvDrafts).where(
      inArray(
        cvDrafts.id,
        obsolete.map((row) => row.id),
      ),
    );
  if (archiveId)
    await tx
      .update(cvDrafts)
      .set({ archivedAt: new Date() })
      .where(eq(cvDrafts.id, archiveId));
  if (currentId)
    await tx
      .update(cvDrafts)
      .set({ archivedAt: null })
      .where(eq(cvDrafts.id, currentId));
}

/** Called in the same fenced transaction that saves the finished content and assessment. */
export async function completeCv(
  tx: Transaction,
  id: string,
  values: Partial<typeof cvDrafts.$inferInsert>,
) {
  await lockCvLifecycle(tx);
  const [draft] = await tx.select().from(cvDrafts).where(eq(cvDrafts.id, id));
  if (!draft) return false; // A deleted build must never recreate itself.
  await tx
    .update(cvDrafts)
    .set({ ...values, status: "ready" })
    .where(eq(cvDrafts.id, id));
  if (draft.archivedAt) return true; // Respect an explicit archive made during generation.
  const rows = await tx
    .select()
    .from(cvDrafts)
    .where(sameRole(draft))
    .orderBy(desc(cvDrafts.createdAt), desc(cvDrafts.id));
  const ready = rows.filter((row) => row.status === "ready" && !row.archivedAt);
  const current = ready[0]!;
  // A slow older build cannot displace a newer ready CV or its newer predecessor.
  const predecessor = ready.find((row) => row.id !== current.id);
  const archive =
    current.id === id && predecessor
      ? predecessor
      : rows.find(
          (row) =>
            row.id !== current.id && (row.status === "ready" || row.archivedAt),
        );
  await retain(tx, draft, current.id, archive?.id);
  return true;
}

export async function actionCvs(
  database: Db,
  ids: string[],
  action: "archive" | "restore" | "delete",
) {
  await database.transaction(async (tx) => {
    await lockCvLifecycle(tx);
    // Newest first makes multiple selections for the same role deterministic.
    const selected = await tx
      .select()
      .from(cvDrafts)
      .where(inArray(cvDrafts.id, ids))
      .orderBy(desc(cvDrafts.createdAt), desc(cvDrafts.id));
    if (action === "delete") {
      await tx.delete(cvDrafts).where(inArray(cvDrafts.id, ids));
      return;
    }
    const handled = new Set<string>();
    for (const target of selected) {
      if (handled.has(target.id)) continue;
      const [exists] = await tx
        .select()
        .from(cvDrafts)
        .where(eq(cvDrafts.id, target.id));
      if (!exists || (action === "archive") === Boolean(exists.archivedAt))
        continue;
      const rows = await tx
        .select()
        .from(cvDrafts)
        .where(sameRole(exists))
        .orderBy(desc(cvDrafts.createdAt), desc(cvDrafts.id));
      rows.forEach((row) => handled.add(row.id));
      const current = rows.find(
        (row) =>
          !row.archivedAt &&
          row.status === "ready" &&
          row.id !== exists.id &&
          (action !== "archive" || !ids.includes(row.id)),
      );
      if (action === "archive") {
        await retain(tx, exists, current?.id, exists.id);
        // Older selected builds also become obsolete when the same role is archived in bulk.
        const olderSelected = rows.filter(
          (row) => ids.includes(row.id) && row.id !== exists.id,
        );
        if (olderSelected.length)
          await tx.delete(cvDrafts).where(
            inArray(
              cvDrafts.id,
              olderSelected.map((row) => row.id),
            ),
          );
      } else {
        await tx
          .update(cvDrafts)
          .set({ archivedAt: null })
          .where(eq(cvDrafts.id, exists.id));
        if (exists.status === "ready")
          await retain(tx, exists, exists.id, current?.id);
      }
    }
  });
}
