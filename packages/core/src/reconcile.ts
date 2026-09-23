/**
 * Pure reconciliation of a scan result against stored jobs. See docs/SPEC.md section 3.4.
 * The caller persists the returned operations.
 */
import type { RawPosting } from "./types";
import { deriveExternalKey, normalizeTitle } from "./normalize";

export type ScanMode = "ok" | "partial" | "none";

/**
 * The least time between a role's first miss and the miss that closes it. Two successful scans an
 * hour apart — a rescan after the daily scan, a retried task, a backlog that ran two days' tasks
 * back to back — are one observation of the board made twice: a role unpublished for an edit, or a
 * cache serving a stale listing, would be absent from both. Six hours makes the second miss a
 * different moment of the board's life, which is what "two consecutive misses" is for.
 */
export const MIN_CLOSE_SEPARATION_MS = 6 * 3_600_000;

export interface ExistingJob {
  id: string;
  externalKey: string;
  status: "open" | "closed";
  missingScans: number;
  /** When the current run of misses began (`jobs.first_missed_at`); null when there is none recorded. */
  firstMissedAt?: Date | null;
  title: string;
  location: string | null;
  normalizedTitle: string;
  closedAt: Date | null;
}

export interface KeyedPosting extends RawPosting {
  externalKey: string;
}

export interface JobUpdate {
  id: string;
  changes: Partial<Pick<KeyedPosting, "title" | "location" | "locations" | "department" | "employmentType" | "remote" | "postedAt" | "salaryText" | "url">>;
  changedFields: string[];
}

export interface ReconcileResult {
  mode: ScanMode;
  inserts: Array<KeyedPosting & { repostOfJobId?: string }>;
  /**
   * Jobs present in the scan: refresh last_seen and reset missing_scans. Both ok and partial scans
   * report them, because being listed is positive evidence whether or not the listing was complete.
   */
  seen: string[];
  updates: JobUpdate[];
  /** Closed jobs present in the scan (ok or partial): reopen them with a fresh miss count. */
  reopened: string[];
  /**
   * Open jobs absent from an ok scan whose miss counts, still below the threshold: missing_scans
   * += 1, and a first miss records when it happened.
   */
  missing: string[];
  /**
   * Open jobs absent again before `MIN_CLOSE_SEPARATION_MS` has passed since their first miss, or
   * missed before with no record of when. Nothing is counted: the caller only records the moment
   * where none is recorded, so the separation is measured from a known time.
   */
  awaitingSeparation: string[];
  /**
   * Open jobs absent for `closeAfterMissing` consecutive ok scans (this one included), the last at
   * least `MIN_CLOSE_SEPARATION_MS` after the first.
   */
  closed: string[];
  duplicateKeysInScan: string[];
}

export interface ReconcileOptions {
  mode: ScanMode;
  /** Consecutive ok scans a job must be absent from before it closes. Default 2. */
  closeAfterMissing?: number;
  /** Look-back for linking a reappearing title+location as a repost. Default 30 days. */
  repostWindowDays?: number;
  now?: Date;
}

export function keyPostings(postings: RawPosting[]): { keyed: KeyedPosting[]; duplicates: string[] } {
  const seen = new Map<string, KeyedPosting>();
  const duplicates: string[] = [];
  for (const p of postings) {
    const externalKey = deriveExternalKey(p);
    if (seen.has(externalKey)) {
      duplicates.push(externalKey);
      // Merge locations of duplicates (same posting listed under several locations without distinct ids).
      const prev = seen.get(externalKey)!;
      const locs = new Set([...(prev.locations ?? []), ...(prev.location ? [prev.location] : []), ...(p.locations ?? []), ...(p.location ? [p.location] : [])]);
      prev.locations = [...locs];
      continue;
    }
    seen.set(externalKey, { ...p, externalKey });
  }
  return { keyed: [...seen.values()], duplicates };
}

function sameArray(a?: string[] | null, b?: string[] | null): boolean {
  const x = [...(a ?? [])].sort();
  const y = [...(b ?? [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export function reconcile(existing: ExistingJob[], postings: RawPosting[], opts: ReconcileOptions): ReconcileResult {
  const now = opts.now ?? new Date();
  const closeAfter = Math.max(2, Number.isFinite(opts.closeAfterMissing) ? Math.floor(opts.closeAfterMissing!) : 2);
  const repostWindowMs = (opts.repostWindowDays ?? 30) * 86_400_000;
  const result: ReconcileResult = {
    mode: opts.mode,
    inserts: [],
    seen: [],
    updates: [],
    reopened: [],
    missing: [],
    awaitingSeparation: [],
    closed: [],
    duplicateKeysInScan: [],
  };
  if (opts.mode === "none") return result;

  const { keyed, duplicates } = keyPostings(postings);
  result.duplicateKeysInScan = duplicates;
  const byKey = new Map(existing.map((j) => [j.externalKey, j]));
  const presentIds = new Set<string>();

  const recentlyClosed = existing.filter(
    (j) => j.status === "closed" && j.closedAt && now.getTime() - j.closedAt.getTime() <= repostWindowMs,
  );

  for (const p of keyed) {
    const job = byKey.get(p.externalKey);
    if (!job) {
      const repost = recentlyClosed.find(
        (j) => j.normalizedTitle === normalizeTitle(p.title) && (j.location ?? "").toLowerCase() === (p.location ?? "").toLowerCase(),
      );
      result.inserts.push(repost ? { ...p, repostOfJobId: repost.id } : p);
      continue;
    }
    presentIds.add(job.id);
    result.seen.push(job.id);
    if (job.status === "closed") result.reopened.push(job.id);
    const changes: JobUpdate["changes"] = {};
    const changedFields: string[] = [];
    if (p.title && p.title !== job.title) {
      changes.title = p.title;
      changedFields.push("title");
    }
    if ((p.location ?? null) !== job.location && p.location !== undefined) {
      changes.location = p.location;
      changedFields.push("location");
    }
    if (changedFields.length) result.updates.push({ id: job.id, changes, changedFields });
  }

  if (opts.mode === "ok") {
    for (const job of existing) {
      if (job.status !== "open" || presentIds.has(job.id)) continue;
      // The first miss always counts (the threshold is at least two, so it never closes).
      if (job.missingScans <= 0) {
        result.missing.push(job.id);
        continue;
      }
      const first = job.firstMissedAt ?? null;
      if (first === null || now.getTime() - first.getTime() < MIN_CLOSE_SEPARATION_MS) {
        result.awaitingSeparation.push(job.id);
        continue;
      }
      if (job.missingScans + 1 >= closeAfter) result.closed.push(job.id);
      else result.missing.push(job.id);
    }
  }
  return result;
}

/** The smallest previous ok listing a collapse is judged against (R-3.8). */
export const SHRINK_FLOOR = 5;

/**
 * Whether a listing collapsed against the last ok scan: under 30% of what a board of at least
 * `SHRINK_FLOOR` roles listed then. An empty listing is `suspect_empty` instead.
 */
export function listingShrank(previousOkCount: number | null, postingsFound: number): boolean {
  return previousOkCount !== null && previousOkCount >= SHRINK_FLOOR && postingsFound > 0 && postingsFound < previousOkCount * 0.3;
}

/** Decide a scan's status from what the fetch and parse produced, relative to the previous ok scan. */
export function classifyScan(params: {
  fetchOk: boolean;
  postingsFound: number;
  previousOkCount: number | null;
  droppedByValidation?: number;
  /**
   * The posting counts of the source's latest scans, newest first, for as long as each was partial
   * because its listing had collapsed. A board that really did shrink would otherwise be partial
   * for ever, because only an ok scan moves the count it is judged against: two collapsed scans
   * with this same count make a third one ok.
   */
  recentShrunkCounts?: number[];
}): "ok" | "partial" | "suspect_empty" | "failed" {
  if (!params.fetchOk) return "failed";
  const prev = params.previousOkCount;
  if (params.postingsFound === 0 && prev !== null && prev >= 3) return "suspect_empty";
  const dropped = params.droppedByValidation ?? 0;
  if (dropped > 0 && dropped / Math.max(1, params.postingsFound + dropped) > 0.2) return "partial";
  if (listingShrank(prev, params.postingsFound)) {
    const [last, before] = params.recentShrunkCounts ?? [];
    return last === params.postingsFound && before === params.postingsFound ? "ok" : "partial";
  }
  return "ok";
}

export function modeForScanStatus(status: "ok" | "partial" | "suspect_empty" | "failed"): ScanMode {
  if (status === "ok") return "ok";
  if (status === "partial") return "partial";
  return "none";
}

export { sameArray as _sameArrayForTests };
