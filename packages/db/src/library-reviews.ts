/**
 * Stored evidence reviews: writing a pass, reading back the ones that still describe what is in
 * the library, and keeping the table from growing with every save.
 *
 * The unit is `(account, library version, entry)`, but the *question* the Library asks is "what is
 * the newest review of this entry as it is written now?" — which is why `latestLibraryReviews`
 * takes an input hash per entry rather than a version. A person who fixes a typo in one job has
 * changed one entry; every other entry keeps its review across the new version and only the one
 * they touched is reviewed again. That is the whole reason the hash exists.
 */
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { LibraryEntryReview } from "@christopher/core";
import type { Db } from "./client";
import { cvLibraryReviews, type CvLibraryReview, type LibraryReviewSource } from "./schema";

export interface LibraryReviewUpsert {
  entryId: string;
  /** `libraryEntryInputHash` of the entry this review is of. */
  inputHash: string;
  review: LibraryEntryReview;
  source: LibraryReviewSource;
  /** The model that produced a `model` review; omitted for the rules baseline. */
  model?: string | null;
}

/**
 * Write a pass. One row per entry per library version: the rules baseline written on save is
 * replaced in place by the model's review when the task lands, rather than accumulating beside it.
 *
 * `created_at` moves on an update, because a replaced review is a new answer to the same question
 * and both the signature and the newest-first read depend on saying so. Duplicate entries in one
 * call are collapsed last-wins, since Postgres refuses to let one statement update a row twice.
 */
export async function upsertLibraryReviews(
  db: Db,
  userId: string,
  libraryVersion: number,
  reviews: LibraryReviewUpsert[],
  now = new Date(),
): Promise<number> {
  const byEntry = new Map(reviews.map(review => [review.entryId, review]));
  if (!byEntry.size) return 0;
  await db.insert(cvLibraryReviews).values([...byEntry.values()].map(review => ({
    userId,
    libraryVersion,
    entryId: review.entryId,
    inputHash: review.inputHash,
    // The score is the one code computed, never one a model reported.
    score: review.review.score,
    rating: review.review.rating,
    source: review.source,
    review: review.review,
    model: review.model ?? null,
    createdAt: now,
  }))).onConflictDoUpdate({
    target: [cvLibraryReviews.userId, cvLibraryReviews.libraryVersion, cvLibraryReviews.entryId],
    set: {
      inputHash: sql`excluded.input_hash`,
      score: sql`excluded.score`,
      rating: sql`excluded.rating`,
      source: sql`excluded.source`,
      review: sql`excluded.review`,
      model: sql`excluded.model`,
      createdAt: sql`excluded.created_at`,
    },
  });
  return byEntry.size;
}

/**
 * The review that still describes each entry, from any library version.
 *
 * A row counts only when its `input_hash` is the one asked for, so a review of an older wording is
 * invisible rather than wrong — an edited entry reads as "not reviewed yet" until its pass runs. A
 * `model` review outranks a `rules` one however old it is: the hash guarantees both describe the
 * same text, the rules baseline is only what is shown while the call is queued, and preferring it
 * by recency would throw away the better answer every time a save rewrote the baseline.
 */
export async function latestLibraryReviews(
  db: Db,
  userId: string,
  entries: Array<{ entryId: string; inputHash: string }>,
): Promise<Map<string, CvLibraryReview>> {
  const wanted = new Map(entries.map(entry => [entry.entryId, entry.inputHash]));
  if (!wanted.size) return new Map();
  const rows = await db
    .select()
    .from(cvLibraryReviews)
    .where(and(
      eq(cvLibraryReviews.userId, userId),
      inArray(cvLibraryReviews.entryId, [...wanted.keys()]),
      inArray(cvLibraryReviews.inputHash, [...new Set(wanted.values())]),
    ))
    .orderBy(
      desc(sql`${cvLibraryReviews.source} = 'model'`),
      desc(cvLibraryReviews.createdAt),
      desc(cvLibraryReviews.libraryVersion),
    );
  const latest = new Map<string, CvLibraryReview>();
  for (const row of rows) {
    // The two IN lists are a cross product: an entry can match another entry's hash. Pair them up.
    if (wanted.get(row.entryId) !== row.inputHash) continue;
    if (!latest.has(row.entryId)) latest.set(row.entryId, row);
  }
  return latest;
}

/**
 * A short fingerprint of one version's reviews, for a poll token: it moves when a review is added,
 * replaced, rescored or reclassified, and not otherwise. Empty until the first review lands, which
 * is what "evaluating…" is shown against.
 */
export async function libraryReviewsSignature(db: Db, userId: string, libraryVersion: number): Promise<string> {
  const [row] = await db
    .select({
      n: sql<number>`count(*)::int`,
      digest: sql<string | null>`md5(string_agg(
        ${cvLibraryReviews.entryId} || ':' || ${cvLibraryReviews.inputHash} || ':' || ${cvLibraryReviews.score}::text
          || ':' || ${cvLibraryReviews.rating} || ':' || ${cvLibraryReviews.source} || ':' || coalesce(${cvLibraryReviews.model}, ''),
        ',' order by ${cvLibraryReviews.entryId}))`,
    })
    .from(cvLibraryReviews)
    .where(and(eq(cvLibraryReviews.userId, userId), eq(cvLibraryReviews.libraryVersion, libraryVersion)));
  return `${row?.n ?? 0}:${(row?.digest ?? "").slice(0, 16)}`;
}

/**
 * Keep the newest `keepVersions` library versions that carry reviews for this account and delete
 * everything older.
 *
 * Deliberately the simple rule: versions, not rows referenced by the current version's hashes. An
 * entry nobody edited is re-reviewed under the new version on the pass that follows a save, so the
 * newest versions already carry every live review; pruning by version cannot orphan one that is
 * still being read. Returns how many rows went.
 */
export async function pruneLibraryReviews(db: Db, userId: string, keepVersions = 20): Promise<number> {
  const keep = Math.max(1, Math.floor(keepVersions));
  const versions = await db
    .selectDistinct({ version: cvLibraryReviews.libraryVersion })
    .from(cvLibraryReviews)
    .where(eq(cvLibraryReviews.userId, userId))
    .orderBy(desc(cvLibraryReviews.libraryVersion))
    .limit(keep);
  if (versions.length < keep) return 0;
  const floor = versions[versions.length - 1]!.version;
  const deleted = await db
    .delete(cvLibraryReviews)
    .where(and(eq(cvLibraryReviews.userId, userId), lt(cvLibraryReviews.libraryVersion, floor)))
    .returning({ id: cvLibraryReviews.id });
  return deleted.length;
}
