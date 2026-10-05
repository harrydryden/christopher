/**
 * Task types and payload shapes shared by the web app (producer) and the worker (consumer).
 *
 * Shared work (discovery, scans, the daily run, description snapshots, company profiles) carries
 * no user: it runs once for everyone who follows the company. Per-account work names its
 * `userId`, or reaches the account through the row it works on (a decision, a CV draft, a
 * discovery source, a candidate), and its dedupe key is scoped the same way.
 */
import type { ScoreBatchRecord } from "./score-batch";

export interface TaskPayloads {
  extract_document: { sourceId: string; documentId: string };
  verify_company: { sourceId?: string; candidateId: string };
  monitor_source: { sourceId: string };
  /**
   * One CV build. `userId` is the draft's owner: the claim orders CV builds by how many each
   * account already has running, and every per-account payload names its account. Typed optional
   * only for producers written before it: `enqueueTask` fills it from the draft, inside the same
   * statement, whenever a producer omits it, so every stored CV task carries it. The rest is
   * what a revision's own task asks for (a rebuild's improvements, a direct edit's `assess`, the
   * parent's rubric); the handler copies it onto the draft's checkpoint so a retry that knows only
   * the draft still finds it.
   */
  generate_cv: { draftId: string; userId?: string; mode?: "assess" | "improve"; rubric?: unknown; improvements?: string[] };
  discover: { companyId: string; logoOnly?: boolean; homepageUrl?: string; url?: string; reason?: "added" | "manual" | "failing" | "suspect_empty" | "shrunk" | "pasted" };
  scan_company: { companyId: string; scanRunId?: string; trigger?: "schedule" | "manual" };
  run_daily: { trigger: "schedule" | "manual"; runDate?: string };
  fetch_description: { jobId: string };
  /** Resolve a Workday listing's counted locations for exactly one observed revision. */
  fetch_locations: { jobId: string; locationRevision: string };
  /**
   * One account's fit score for one role. `live` marks a role that batch scoring handed back —
   * its batch request expired or errored, or the batch could not be sent — so the queue runs it
   * as an ordinary call even while scoring is in batch mode. `background` marks a rescore pass's
   * role, which nobody is waiting on: the batch collector takes it even while scoring is live, and
   * the queue leaves it alone unless it is also marked `live`.
   */
  score_job: { userId: string; jobId: string; live?: boolean; background?: boolean };
  /** Exact, bounded score requests. The worker checks its own model and account budget before
   * creating score_job tasks; a view's mutable state is never the request ledger. */
  admit_scores: { userId: string; jobIds: string[]; requestKey: string; background?: boolean; onlyUnscored?: boolean };
  /**
   * Batch scoring's collector: gathers the queued `score_job` work into one Message Batches
   * request. Shared work — it serves every account with roles waiting — so it names none.
   */
  collect_score_batch: { reason?: "schedule" | "backlog" };
  /**
   * Poll one submitted scoring batch and apply its results once it has ended. The payload is the
   * batch's own record: which task, account and role each request was for, what each was held
   * at, and the hold taken per account (`ScoreBatchRecord` in `score-batch`).
   */
  poll_score_batch: ScoreBatchRecord;
  tag_reason: { decisionId: string };
  /** Resume tagging reasons saved before confirmation, in bounded decision-id pages. */
  resume_reason_tags: { userId: string; afterDecisionId?: string };
  synthesize_profile: { userId: string; force?: boolean };
  suggest_filters: { userId: string };
  suggest_from_scans: { userId: string };
  profile_company: { companyId: string };
  suggest_companies: { userId: string; limit?: number };
  rescore_all: { userId: string; onlyInTable?: boolean };
  /**
   * Without a `userId` every account is re-evaluated; `companyId` narrows it to one company's
   * postings. `reason: "boot"` marks the re-evaluation a release queues when the gate's meaning
   * changed (see `GATE_REEVALUATION_VERSION`): nobody asked for it, so it waits behind what they did.
   */
  reevaluate_gate: { userId?: string; companyId?: string; reason?: "boot" };
  /**
   * One posting a follower pasted the URL of, fetched and extracted into the shared catalogue.
   * The row it stores is shared like any other posting; the view it creates is this account's.
   */
  import_posting: {
    userId: string;
    companyId: string;
    url: string;
    /**
     * The action found the URL on a host the company does not own (not its homepage's domain, an
     * HTML source's host or its own ATS board). The handler keeps such a posting to the account
     * that pasted it rather than filing it under the company for every follower.
     */
    foreignHost?: boolean;
  };
  /**
   * Review one account's evidence library for how well each entry evidences itself. The version
   * is what the save that enqueued it produced; the handler reads the newest one, because the
   * dedupe key is the account and a burst of saves must run once, for what is there when it runs.
   */
  review_library: { userId: string; libraryVersion: number };
  /**
   * One document on its way into an account's Library: a past CV, LinkedIn's own PDF of a
   * profile, a personal website or pasted text. The row carries the document; the task carries
   * the id of the row, so an upload never travels through the queue.
   */
  import_library_document: { userId: string; importId: string };
  /** Read a private role link or PDF into an account-owned confirmation draft. */
  import_role_description: { userId: string; importId: string };
  /**
   * One pass of the one-off backfill that re-encodes stored company logos as small WebP images,
   * as a capture now stores them. A pass takes a bounded batch in company order after
   * `afterCompanyId` and queues the next pass itself while there is more to do, so the whole
   * catalogue is walked once without any one task holding a slot for long. Shared work: logos
   * belong to the catalogue, not to an account.
   */
  reencode_logos: { afterCompanyId?: string };
}

export type TaskType = keyof TaskPayloads;

/**
 * The version of what the keyword and location gate means. A worker that boots on a newer version
 * than the one last applied re-runs every account's gate once, so tables built by the old rules
 * are brought into line; a boot on the same version queues nothing.
 *
 * Every table used to be re-walked on every boot — each deploy and each crash-loop restart — which
 * put a thousand whole-account walks in the interactive lane for work that had not changed. Any
 * change to what `evaluateGate` (gate.ts) decides for a posting must bump this number, and
 * `gate-reevaluation-version.test.ts` fails until it is bumped and its digest recorded.
 */
export const GATE_REEVALUATION_VERSION = 2;

/**
 * The types a person is waiting for. The queue's interactive lane serves these first, and ageing
 * reads its floor from their priorities. Defined here rather than in the worker so the floor and
 * the lane cannot disagree about which types count.
 */
export const INTERACTIVE_TASK_TYPES = [
  "generate_cv", "discover", "tag_reason", "reevaluate_gate", "admit_scores", "import_posting", "review_library", "import_library_document", "import_role_description",
] as const satisfies readonly TaskType[];

/** The shared daily scan and its fan-out: the scan lane's own work. */
export const SCAN_TASK_TYPES = ["scan_company", "run_daily"] as const satisfies readonly TaskType[];

/**
 * Every task type's queue behaviour: its priority (lower runs first; interactive tasks jump the
 * queue) and its dedupe key, which a second enqueue of the same work collapses onto (null: never
 * deduplicated). The compiler demands an entry for every type in `TaskPayloads`, so a new type
 * cannot slip through with a default.
 */
const TASKS: { [T in TaskType]: { priority: number; dedupe: (p: TaskPayloads[T]) => string | null } } = {
  extract_document: { priority: 5, dedupe: (p) => `extract_document:${p.documentId}` },
  verify_company: { priority: 5, dedupe: (p) => `verify_company:${p.candidateId}` },
  monitor_source: { priority: 5, dedupe: (p) => `monitor_source:${p.sourceId}` },
  discover: { priority: 1, dedupe: (p) => (p.logoOnly ? `company_logo:${p.companyId}:${p.homepageUrl}` : `discover:${p.companyId}`) },
  scan_company: { priority: 5, dedupe: (p) => `scan_company:${p.companyId}` },
  run_daily: { priority: 5, dedupe: () => "run_daily" },
  fetch_description: { priority: 4, dedupe: (p) => `fetch_description:${p.jobId}` },
  fetch_locations: { priority: 4, dedupe: (p) => `fetch_locations:${p.jobId}:${p.locationRevision}` },
  score_job: { priority: 4, dedupe: (p) => `score_job:${p.userId}:${p.jobId}` },
  admit_scores: { priority: 1, dedupe: (p) => `admit_scores:${p.userId}:${p.requestKey}` },
  tag_reason: { priority: 1, dedupe: (p) => `tag_reason:${p.decisionId}` },
  resume_reason_tags: { priority: 6, dedupe: (p) => `resume_reason_tags:${p.userId}` },
  synthesize_profile: { priority: 6, dedupe: (p) => `synthesize_profile:${p.userId}` },
  suggest_filters: { priority: 6, dedupe: (p) => `suggest_filters:${p.userId}` },
  suggest_from_scans: { priority: 6, dedupe: (p) => `suggest_from_scans:${p.userId}` },
  profile_company: { priority: 6, dedupe: (p) => `profile_company:${p.companyId}` },
  suggest_companies: { priority: 7, dedupe: (p) => `suggest_companies:${p.userId}` },
  rescore_all: { priority: 6, dedupe: (p) => `rescore_all:${p.userId}` },
  reevaluate_gate: { priority: 1, dedupe: (p) => `reevaluate_gate:${p.userId ?? "all"}${p.companyId ? `:${p.companyId}` : ""}` },
  // Someone asked for this CV and is watching it build. One step behind the quick interactive
  // work, as the interface has always queued it, because a build holds its slot for minutes.
  // Keyed by the draft, not the account: a draft id is already one account's, and the interface
  // and the abandonment hooks find a build's task by exactly this key.
  generate_cv: { priority: 2, dedupe: (p) => `generate_cv:${p.draftId}` },
  import_posting: { priority: 1, dedupe: (p) => `import_posting:${p.userId}:${p.companyId}:${p.url}` },
  // Someone is looking at the Library, waiting for the scores to land. Deliberately not scoped to
  // the version: the editor saves the whole library at once, so a person typing through five saves
  // would otherwise queue five passes over the same entries.
  review_library: { priority: 1, dedupe: (p) => `review_library:${p.userId}` },
  // Someone has just handed over their CV and is watching the page for what came of it. Keyed by
  // the import, not the account: two documents brought in the same minute are two extractions, and
  // re-reading one that failed is the same piece of work rather than a second one.
  import_library_document: { priority: 1, dedupe: (p) => `import_library_document:${p.importId}` },
  import_role_description: { priority: 1, dedupe: (p) => `import_role_description:${p.importId}` },
  collect_score_batch: { priority: 4, dedupe: () => "collect_score_batch" },
  poll_score_batch: { priority: 4, dedupe: (p) => `poll_score_batch:${p.batchId}` },
  // Housekeeping nobody is waiting for: behind everything else, and one walk at a time — a second
  // request while a pass waits to start is the same walk.
  reencode_logos: { priority: 7, dedupe: () => "reencode_logos" },
};

/** Every task type; @col/db's `tasks.type` column enum is this list, re-exported. */
export const TASK_TYPE_NAMES = Object.keys(TASKS) as [TaskType, ...TaskType[]];

export function dedupeKeyFor<T extends TaskType>(type: T, payload: TaskPayloads[T]): string | null {
  return (TASKS[type].dedupe as (p: TaskPayloads[T]) => string | null)(payload);
}

export function priorityFor(type: TaskType): number {
  return TASKS[type].priority;
}

/**
 * How far ageing may lift a waiting task: the least urgent priority any interactive type is
 * enqueued at, which is where a CV build waits.
 *
 * Ageing used to have no floor, so everything that waited converged on 0 and a person's fresh
 * import, discovery or shortlist score (priority 1) queued behind the whole backlog. Stopping here
 * keeps waiting work moving up without ever letting it overtake what someone has just asked for:
 * at best it ties with a queued CV build, and the claim then takes the one that has been ready
 * longer.
 */
export const AGEING_PRIORITY_FLOOR = Math.max(...INTERACTIVE_TASK_TYPES.map(priorityFor));

/**
 * How long one handler may run before its task is abandoned and failed.
 *
 * Nothing else bounds a handler: a fetch that hangs past its own timeouts, or a model call that
 * never returns, would otherwise hold a slot until the process restarts. `scan_company` is the
 * three minutes per company R-3.1 asks for; discovery walks several pages. Everything else is
 * short by construction.
 *
 * A CV build's deadline is the sum of its stages' allowances (`CV_STAGE_ALLOWANCE_MS`), never
 * less than three quarters of an hour. Each stage is also stopped at its own allowance, so one
 * runaway stage cannot spend the whole deadline and leave the stages after it none: the ceilings
 * and the deadline agree by construction. Reaching either aborts the run's model calls, so a
 * build that outruns it stops spending instead of carrying on unobserved.
 *
 * It lives here rather than in the worker because the interface shows elapsed time against the
 * deadline, and nothing in `apps/web` may import `apps/worker`.
 */
/**
 * How long each stage of a CV build may take before it is stopped, in milliseconds. Calibration
 * constants, not measurements: each is the stage's model calls at their request timeouts with
 * room for the streams, until the call ledger supplies a measured 95th percentile per stage.
 *
 * `write` is three author calls of up to five minutes and the renders between them; `audit` and
 * `reaudit` are the first batch alone, the rest together and one attribution re-run; `improve` is
 * one author call; `overhead` is the renders, saves and publication outside any stage.
 */
export const CV_STAGE_ALLOWANCE_MS = {
  rubric: 4 * 60_000,
  plan: 6 * 60_000,
  write: 20 * 60_000,
  audit: 12 * 60_000,
  improve: 6 * 60_000,
  reaudit: 12 * 60_000,
  overhead: 2 * 60_000,
} as const;

/** The least a CV build is ever given, whatever the allowances add up to. */
export const CV_BUILD_DEADLINE_FLOOR_MS = 45 * 60_000;

/** The deadline a CV build's task is given: its stages' allowances added up, with a floor. */
export function cvBuildDeadlineMs(allowances: Record<string, number> = CV_STAGE_ALLOWANCE_MS): number {
  return Math.max(CV_BUILD_DEADLINE_FLOOR_MS, Object.values(allowances).reduce((sum, ms) => sum + ms, 0));
}

export const TASK_DEADLINES_MS: Partial<Record<TaskType, number>> & { default: number } = {
  scan_company: 3 * 60_000,
  generate_cv: cvBuildDeadlineMs(),
  discover: 5 * 60_000,
  // A page fetch, a browser render when the page needs one, and one model call.
  import_posting: 4 * 60_000,
  // One batched model call per eight entries, each seeing the whole library from the cache.
  review_library: 4 * 60_000,
  // A conversion or a page fetch, then one model call over a document of up to 40,000 characters.
  import_library_document: 4 * 60_000,
  import_role_description: 4 * 60_000,
  // One high-effort call of up to 8,000 streamed tokens with up to five web searches: a minute to
  // begin, two or more to write, and the searches between. Two minutes failed it mid-answer, so
  // the call was paid for and made again.
  extract_document: 6 * 60_000,
  // One high-effort call of up to 6,000 tokens over the account's decisions: a minute to begin and
  // up to two to write, with room for the client's own retry before the answer starts.
  synthesize_profile: 5 * 60_000,
  // The same shape as extraction with up to fifteen web searches.
  suggest_companies: 7 * 60_000,
  // Up to `SCORE_BATCH_MAX_ITEMS` roles read and prepared, one hold per account, one request.
  collect_score_batch: 5 * 60_000,
  // One retrieval, then up to that many results applied, one short transaction each.
  poll_score_batch: 5 * 60_000,
  default: 2 * 60_000,
};

/**
 * A manual rescan of a company scanned this recently is served by the existing result.
 *
 * The catalogue is shared and scanned once a day for everyone, so "Refresh" is a request, not a
 * command: a source another follower read minutes ago is not fetched again. It lives here beside
 * the deadlines because both the scan handler that enforces it and the interface that promises it
 * ("a scan made in the last half hour is reused") have to say the same number, and `apps/web` may
 * not import `apps/worker`.
 */
export const MANUAL_RESCAN_INTERVAL_MS = 30 * 60_000;

/**
 * A source is marked `failing`, and re-discovery queued, after this many consecutive failed scans
 * (`apps/worker/src/handlers/scan.ts`). It lives here beside the rescan window because Health names
 * the figure and `apps/web` may not import `apps/worker`.
 */
export const SOURCE_FAILING_AFTER = 3;

export type TaskDeadlines = Partial<Record<TaskType | "default", number>>;

/** The deadline for one type: the caller's override first, then the table above. */
export function deadlineMsFor(type: TaskType, overrides: TaskDeadlines = {}): number {
  return overrides[type] ?? overrides.default ?? TASK_DEADLINES_MS[type] ?? TASK_DEADLINES_MS.default;
}

/** The same function under the shorter name the interface calls it by. */
export { deadlineMsFor as deadlineFor };

/**
 * A short human label for what a task is for, read from its payload: the company, draft or
 * account behind it. Used when a crash recovery has to name the tasks that were running.
 */
export function taskSubject(type: TaskType, payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload) return null;
  const pick = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string) : null);
  const subject = pick("draftId") ?? pick("companyId") ?? pick("jobId") ?? pick("sourceId")
    ?? pick("candidateId") ?? pick("documentId") ?? pick("importId") ?? pick("decisionId") ?? pick("userId");
  return subject ? `${type}:${subject}` : null;
}

/** The account a task's payload names, when it names one. Shared work carries none. */
export function taskUserId(payload: Record<string, unknown> | null | undefined): string | null {
  const userId = payload?.userId;
  return typeof userId === "string" ? userId : null;
}
