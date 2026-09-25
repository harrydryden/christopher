/**
 * Writing a new version of an account's Library, for the actions that write one.
 *
 * Deliberately not a `"use server"` module. Every export of one is a public endpoint, and this
 * writes the Library of whichever account it is handed: the callers — `saveCvLibrary`, the gap
 * quiz and the document import — authenticate first and pass the session's account, and nothing
 * here checks it again.
 */
import { desc, eq, sql } from "drizzle-orm";
import { cvLibraries, enqueueTask } from "@ava/db";
import { CvLibrarySchema, consolidateExperience, retainArchivedEvidence, type CvLibrary } from "@ava/core";
import type { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
import { UserFacingError } from "@/lib/validation";

export type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

/** Queue the evidence review (A12) of an account's newest Library. */
export async function enqueueLibraryReview(tx: Pick<Tx, "insert">, userId: string, version: number) {
  await enqueue("review_library", { userId, libraryVersion: version }, tx);
}

/** The account's newest Library version, or undefined before the first save. */
export async function latestLibrary(tx: Pick<Tx, "select">, userId: string) {
  const [latest] = await tx.select().from(cvLibraries).where(eq(cvLibraries.userId, userId)).orderBy(desc(cvLibraries.version)).limit(1);
  return latest;
}

/**
 * One saved version of a Library, written the way every save writes one.
 *
 * Extracted from `saveCvLibrary` so that the document import can land accepted items through the
 * same path rather than a parallel one: the same advisory lock, the same obsolete-edit rejection,
 * the same archived-evidence retention, the same tasks queued behind it. `build` is given the
 * version it is writing over — the import needs it, to add to what is there rather than replace
 * it — and returns the library to store.
 *
 * It takes the caller's transaction and the caller's account: everything it writes is decided by
 * `build`, for the `userId` a server action has already authenticated.
 */
export async function writeCvLibraryVersion(
  tx: Tx,
  userId: string,
  expectedVersion: number,
  build: (current: CvLibrary | null) => CvLibrary,
  options: { review?: boolean } = {},
): Promise<number> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cv:library:${userId}`}))`);
  const latest = await latestLibrary(tx, userId);
  if ((latest?.version ?? 0) !== expectedVersion) throw new UserFacingError("The library changed. Reload before saving.");
  const version = (latest?.version ?? 0) + 1;
  const content = CvLibrarySchema.parse(consolidateExperience(build(latest?.content ?? null)));
  await tx.insert(cvLibraries).values({ userId, version, content: CvLibrarySchema.parse(retainArchivedEvidence(latest?.content, content)) });
  await enqueueTask(tx, "rescore_all", { userId, onlyInTable: true }, { dedupeKey: `rescore_all:${userId}`, priority: 5 });
  // The evidence review of the version this save just wrote, for the writes the person did not
  // type: an accepted import and a gap quiz's answers. A save from the Library editor passes
  // `review: false`, because there the review is the person's to ask for — the Re-score button,
  // `rescoreLibrary` — and the page scores the saved rows from their own tags until they do. Its
  // dedupe key is the account, not the version, so a burst of writes queues one pass; the handler
  // reads the newest library when it runs.
  if (options.review !== false) await enqueueLibraryReview(tx, userId, version);
  return version;
}
