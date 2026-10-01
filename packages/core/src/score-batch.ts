/**
 * Background fit scoring through the Message Batches API: the pure parts.
 *
 * In batch mode (`scoringMode: "batch"`) the worker's collector gathers the queued `score_job`
 * work into one batch request, holds each account's share of it against that account's budget at
 * the batch price, and a poll task applies the scores once the batch has ended. What lives here is
 * what those steps have to agree on without a database: how a request is named, how the holds are
 * grouped, and how often an unfinished batch is looked at again.
 */

/** The most roles one collection sends; a longer backlog is collected again at once. */
export const SCORE_BATCH_MAX_ITEMS = 500;

/**
 * How long a batch's holds live. A batch that has not ended in 24 hours expires, and its unsent
 * requests are not billed; the two hours past that cover the last poll and the results it applies.
 */
export const SCORE_BATCH_HOLD_MINUTES = 26 * 60;

/** One role in a submitted batch, as its poll task needs it. */
export interface ScoreBatchItem {
  /** The request's `custom_id`: its task, account and role (`scoreBatchCustomId`). */
  customId: string;
  taskId: string;
  userId: string;
  jobId: string;
  /** What this request is held at, at the batch price. Taken off the account's hold when its result lands. */
  estimateUsd: number;
  /** The hash of what the score is computed from, stored on the view with the score. */
  fingerprint: string;
  /** View request number. Optional only for batches persisted before the publication migration. */
  attemptVersion?: number;
  /** The preference profile version the score was asked against. */
  profileVersion: number | null;
  /** When the inputs were read (ISO); ordering uses attemptVersion. */
  preparedAt: string;
}

/** A submitted scoring batch: the poll task's payload. */
export interface ScoreBatchRecord {
  batchId: string;
  /** When the provider accepted it (ISO). */
  submittedAt: string;
  model: string;
  promptId: string;
  promptVersion: string;
  items: ScoreBatchItem[];
  /** The hold taken for each account's share, by account: the `ai_reservations` row id. */
  holds: Record<string, string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function uuidBytes(id: string): number[] {
  const hex = id.replace(/-/g, "");
  return Array.from({ length: 16 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

function bytesUuid(bytes: number[]): string {
  const hex = bytes.map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The `custom_id` of one scoring request: its task, account and role, in that order.
 *
 * The provider allows 1 to 64 characters of `[a-zA-Z0-9_-]`, so `taskId:userId:jobId` spelled out
 * (110 characters, with colons) would be refused. The three ids are 48 bytes, which base64url
 * writes in exactly 64 characters with no padding, so the name still carries all three and nothing
 * else, and `parseScoreBatchCustomId` reads them back. Null when any of them is not a uuid: that
 * request cannot be named, and is scored live instead.
 */
export function scoreBatchCustomId(taskId: string, userId: string, jobId: string): string | null {
  if (![taskId, userId, jobId].every(id => UUID.test(id))) return null;
  const bytes = [...uuidBytes(taskId), ...uuidBytes(userId), ...uuidBytes(jobId)];
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  return out;
}

/** The task, account and role a `custom_id` names, or null for one this code did not write. */
export function parseScoreBatchCustomId(customId: string): { taskId: string; userId: string; jobId: string } | null {
  if (!/^[A-Za-z0-9_-]{64}$/.test(customId)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < customId.length; i += 4) {
    const n = [0, 1, 2, 3].reduce((acc, k) => (acc << 6) | ALPHABET.indexOf(customId[i + k]!), 0);
    bytes.push((n >> 16) & 255, (n >> 8) & 255, n & 255);
  }
  return { taskId: bytesUuid(bytes.slice(0, 16)), userId: bytesUuid(bytes.slice(16, 32)), jobId: bytesUuid(bytes.slice(32, 48)) };
}

/**
 * Each account's share of a batch: the sum of its requests' estimates. Budgets are per account,
 * so a batch that serves five accounts takes five holds, and an account with no room left is
 * refused alone rather than refusing the batch. Rounded to the micro-dollar, as costs are.
 */
export function scoreBatchHolds(items: ReadonlyArray<Pick<ScoreBatchItem, "userId" | "estimateUsd">>): Map<string, number> {
  const holds = new Map<string, number>();
  for (const item of items) holds.set(item.userId, (holds.get(item.userId) ?? 0) + item.estimateUsd);
  for (const [userId, amount] of holds) holds.set(userId, Number(amount.toFixed(6)));
  return holds;
}

/**
 * How long to wait before looking at a running batch again, from how long it has been running:
 * half that, at least a minute and at most fifteen. Most batches end within the hour, so the first
 * looks are close together; one that runs for most of a day is looked at about a hundred times
 * rather than every minute of it. Read from the clock rather than counted, so the poll task's
 * payload — the whole batch's record — is never rewritten to keep count.
 */
export function scoreBatchPollDelayMs(runningMs: number): number {
  return Math.round(Math.min(15 * 60_000, Math.max(60_000, Math.max(0, runningMs) / 2)));
}
