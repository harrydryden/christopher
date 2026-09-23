/**
 * How many CV builds one account may have waiting for the worker at once.
 *
 * A build is the dearest and the longest task the worker runs, and the queue serves it in the
 * order it was asked for. Without a cap, one account asking for a CV for every role in its table
 * put every other account's build behind its own for hours. Three is enough for anyone applying
 * in earnest, and it is counted per account, so nobody's cap is spent by somebody else.
 *
 * The count is taken under an advisory lock on the account, because two requests for two different
 * roles hold two different role locks and would otherwise both see room for one more. The lock is
 * always the first one a transaction takes, before any role lock, so it cannot deadlock against
 * the worker, which takes only role locks.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@ava/db";
import { cvDrafts } from "@ava/db/schema";
import { UserFacingError } from "@/lib/validation";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Drafts one account may have queued or generating at the same time. */
export const MAX_CV_BUILDS_IN_FLIGHT = 3;

/** What the account is told when it asks for one more. */
export const CV_BUILD_CAP_MESSAGE =
  `You already have ${MAX_CV_BUILDS_IN_FLIGHT} CVs building. Wait for one of them to finish before starting another.`;

/** Serialise this account's build requests. Taken first, before any role lock. */
export async function lockCvBuildCapacity(tx: Transaction, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cv:builds:${userId}`}))`);
}

/**
 * Refuse, in a sentence, a build that would be this account's fourth waiting for the worker.
 *
 * A build paused on its evidence questions is not counted: it holds no place in the queue, and
 * continuing it is finishing a build that was already admitted rather than starting another.
 */
export async function assertCvBuildCapacity(tx: Transaction, userId: string): Promise<void> {
  await lockCvBuildCapacity(tx, userId);
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(cvDrafts)
    .where(and(eq(cvDrafts.userId, userId), isNull(cvDrafts.archivedAt), inArray(cvDrafts.status, ["queued", "generating"])));
  if ((row?.n ?? 0) >= MAX_CV_BUILDS_IN_FLIGHT) throw new UserFacingError(CV_BUILD_CAP_MESSAGE);
}
