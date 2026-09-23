/**
 * Task types and payload shapes shared by the web app (producer) and the worker (consumer).
 *
 * Shared work (discovery, scans, the daily run, description snapshots, company profiles) carries
 * no user: it runs once for everyone who follows the company. Per-account work names its
 * `userId`, or reaches the account through the row it works on (a decision, a CV draft, a
 * discovery source, a candidate), and its dedupe key is scoped the same way.
 */

export interface TaskPayloads {
  extract_document: { sourceId: string; documentId: string };
  verify_company: { sourceId?: string; candidateId: string };
  monitor_source: { sourceId: string };
  generate_cv: { draftId: string };
  discover: { companyId: string; logoOnly?: boolean; homepageUrl?: string; url?: string; reason?: "added" | "manual" | "failing" | "suspect_empty" | "shrunk" | "pasted" };
  scan_company: { companyId: string; scanRunId?: string; trigger?: "schedule" | "manual" };
  run_daily: { trigger: "schedule" | "manual"; runDate?: string };
  fetch_description: { jobId: string };
  score_job: { userId: string; jobId: string };
  tag_reason: { decisionId: string };
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
  import_posting: { userId: string; companyId: string; url: string };
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
export const GATE_REEVALUATION_VERSION = 1;

export function dedupeKeyFor<T extends TaskType>(type: T, payload: TaskPayloads[T]): string | null {
  switch (type) {
    case "extract_document": return `extract_document:${(payload as TaskPayloads["extract_document"]).documentId}`;
    case "verify_company": return `verify_company:${(payload as TaskPayloads["verify_company"]).candidateId}`;
    case "monitor_source": return `monitor_source:${(payload as TaskPayloads["monitor_source"]).sourceId}`;
    case "generate_cv": return `generate_cv:${(payload as TaskPayloads["generate_cv"]).draftId}`;
    case "discover":
      { const p = payload as TaskPayloads["discover"];
        return p.logoOnly ? `company_logo:${p.companyId}:${p.homepageUrl}` : `discover:${p.companyId}`; }
    case "scan_company":
      return `scan_company:${(payload as TaskPayloads["scan_company"]).companyId}`;
    case "run_daily":
      return `run_daily`;
    case "fetch_description":
      return `fetch_description:${(payload as TaskPayloads["fetch_description"]).jobId}`;
    case "score_job":
      { const p = payload as TaskPayloads["score_job"]; return `score_job:${p.userId}:${p.jobId}`; }
    case "tag_reason":
      return `tag_reason:${(payload as TaskPayloads["tag_reason"]).decisionId}`;
    case "synthesize_profile":
      return `synthesize_profile:${(payload as TaskPayloads["synthesize_profile"]).userId}`;
    case "suggest_filters":
      return `suggest_filters:${(payload as TaskPayloads["suggest_filters"]).userId}`;
    case "suggest_from_scans":
      return `suggest_from_scans:${(payload as TaskPayloads["suggest_from_scans"]).userId}`;
    case "profile_company":
      return `profile_company:${(payload as TaskPayloads["profile_company"]).companyId}`;
    case "suggest_companies":
      return `suggest_companies:${(payload as TaskPayloads["suggest_companies"]).userId}`;
    case "rescore_all":
      return `rescore_all:${(payload as TaskPayloads["rescore_all"]).userId}`;
    case "reevaluate_gate":
      { const p = payload as TaskPayloads["reevaluate_gate"];
        return `reevaluate_gate:${p.userId ?? "all"}${p.companyId ? `:${p.companyId}` : ""}`; }
    case "import_posting":
      { const p = payload as TaskPayloads["import_posting"];
        return `import_posting:${p.userId}:${p.companyId}:${p.url}`; }
    // Deliberately not scoped to the version: the editor saves the whole library at once, so a
    // person typing through five saves would otherwise queue five passes over the same entries.
    case "review_library":
      return `review_library:${(payload as TaskPayloads["review_library"]).userId}`;
    // The import, not the account: two documents brought in the same minute are two extractions,
    // and re-reading one that failed is the same piece of work rather than a second one.
    case "import_library_document":
      return `import_library_document:${(payload as TaskPayloads["import_library_document"]).importId}`;
    default:
      return null;
  }
}

/**
 * The types a person is waiting for. The queue's interactive lane serves these first, and ageing
 * reads its floor from their priorities. Defined here rather than in the worker so the floor and
 * the lane cannot disagree about which types count.
 */
export const INTERACTIVE_TASK_TYPES = [
  "generate_cv", "discover", "tag_reason", "reevaluate_gate", "import_posting", "review_library", "import_library_document",
] as const satisfies readonly TaskType[];

/** The shared daily scan and its fan-out: the scan lane's own work. */
export const SCAN_TASK_TYPES = ["scan_company", "run_daily"] as const satisfies readonly TaskType[];

/** Lower runs first. Interactive tasks jump the queue. */
export function priorityFor(type: TaskType): number {
  switch (type) {
    // Someone asked for this CV and is watching it build. One step behind the quick interactive
    // work, as the interface has always queued it, because a build holds its slot for minutes.
    case "generate_cv":
      return 2;
    case "discover":
    case "tag_reason":
    case "reevaluate_gate":
    case "import_posting":
    // Someone is looking at the Library, waiting for the scores to land.
    case "review_library":
    // Someone has just handed over their CV and is watching the page for what came of it.
    case "import_library_document":
      return 1;
    case "fetch_description":
    case "score_job":
      return 4;
    case "scan_company":
    case "run_daily":
      return 5;
    case "synthesize_profile":
    case "suggest_filters":
    case "suggest_from_scans":
    case "profile_company":
    case "rescore_all":
      return 6;
    case "suggest_companies":
      return 7;
    default:
      return 5;
  }
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
 * A CV build gets three quarters of an hour, because half an hour is reachable by a build that is
 * working perfectly: three writing attempts of up to five minutes each, the first assessment batch
 * serially before the rest, and a stream that may legitimately take the fifteen-minute stall
 * ceiling before it is cut off. The deadline is the ceiling for a build that has stopped, not a
 * budget a slow one must fit; reaching it now aborts the run's signal, so a build that outruns it
 * stops spending instead of carrying on unobserved.
 *
 * It lives here rather than in the worker because the interface shows elapsed time against the
 * deadline, and nothing in `apps/web` may import `apps/worker`.
 */
export const TASK_DEADLINES_MS: Partial<Record<TaskType, number>> & { default: number } = {
  scan_company: 3 * 60_000,
  generate_cv: 45 * 60_000,
  discover: 5 * 60_000,
  // A page fetch, a browser render when the page needs one, and one model call.
  import_posting: 4 * 60_000,
  // One batched model call per eight entries, each seeing the whole library from the cache.
  review_library: 4 * 60_000,
  // A conversion or a page fetch, then one model call over a document of up to 40,000 characters.
  import_library_document: 4 * 60_000,
  // One high-effort call of up to 8,000 streamed tokens with up to five web searches: a minute to
  // begin, two or more to write, and the searches between. Two minutes failed it mid-answer, so
  // the call was paid for and made again.
  extract_document: 6 * 60_000,
  // One high-effort call of up to 6,000 tokens over the account's decisions: a minute to begin and
  // up to two to write, with room for the client's own retry before the answer starts.
  synthesize_profile: 5 * 60_000,
  // The same shape as extraction with up to fifteen web searches.
  suggest_companies: 7 * 60_000,
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

/** Every task type, checked against `TaskPayloads` by the compiler in both directions. */
const EVERY_TASK_TYPE: Record<TaskType, true> = {
  extract_document: true, verify_company: true, monitor_source: true, generate_cv: true, discover: true,
  scan_company: true, run_daily: true, fetch_description: true, score_job: true, tag_reason: true,
  synthesize_profile: true, suggest_filters: true, suggest_from_scans: true, profile_company: true,
  suggest_companies: true, rescore_all: true, reevaluate_gate: true, import_posting: true,
  review_library: true, import_library_document: true,
};
export const TASK_TYPE_NAMES = Object.keys(EVERY_TASK_TYPE) as TaskType[];

/** The longest deadline a task may have and still count as short. */
export const SHORT_TASK_DEADLINE_MS = 45_000;

/**
 * The types whose deadline is at most `SHORT_TASK_DEADLINE_MS`, read from the table above: what a
 * runner with well under a minute to spend — a serverless invocation — can claim and still see
 * finish or fail inside its own time. A type that no longer fits drops out of the list when its
 * deadline moves; nothing else has to change. With every deadline at two minutes or more, no type
 * is short today.
 */
export const SHORT_TASK_TYPES: readonly TaskType[] = TASK_TYPE_NAMES.filter(type => deadlineMsFor(type) <= SHORT_TASK_DEADLINE_MS);

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
