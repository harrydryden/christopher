/**
 * Rebuild a saved CV to grade it, without touching it: the record → replay → grade gate.
 *
 * `replayCvDraft` takes a draft's snapshot — its Library, the description, the CV model, the rubric
 * its assessment was made against and the evidence plan kept in `cv_tailoring_plans` — and runs it
 * through the real CV handler (`handleGenerateCv`): the shipped prompts, the engine, every
 * validator, the page fitter, the audit and the optional improvement. What it builds is graded and
 * reported; nothing of it is kept.
 *
 * How nothing is kept: the whole run happens inside one database transaction that is always rolled
 * back. Inside it the draft is copied to a scratch account created for the run, so the handler's
 * writes — the copy's status and content, its journal, its publication and any adopted revision —
 * land on rows no one else can see and that vanish with the rollback; the real draft is only read.
 * The budget is not touched at all: the handler is given a sink (`CvBuildSink`) that holds nothing
 * and keeps each call's record in memory, so no hold is taken, no `ai_calls` row is written and no
 * account-wide or deployment-wide budget lock is waited on. The handler enqueues no tasks. Locks the
 * run does take are on the scratch account's own rows and keys, held until the rollback.
 *
 * The model calls go to whichever client the caller gives: a `ReplayClient` serving a recording
 * (no key, no cost, and a miss names the prompt and version that moved), or the provider for a live
 * run, optionally through a `RecordingClient` (`recordCvDraft`), which is how a recording is made.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync, appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  CV_PROMPT_IDS,
  PROMPTS,
  RecordingClient,
  ReplayClient,
  createProviderClient,
  promptSetVersion,
  resolveRoute,
  routedModel,
  type AiClientLike,
  type Effort,
  type RecordingKey,
  type StageRoutes,
} from "@ava/ai";
import { schema, type Db, type Task } from "@ava/db";
import { cvMaxPages } from "@ava/core";
import { cvMatchPoints, type CvAssessment } from "@ava/core/cv-assessment";
import { diagnoseCvQuality, type CvQualityDiagnostics } from "@ava/core/cv-quality";
import type { CvContent } from "@ava/core/cv";
import type { WorkerDeps } from "./context";
import { handleGenerateCv, type CvBuildSink } from "./handlers/cv";
import type { AiHold } from "./budget";

/** The repository root, so a report names a recording inside it by a path that means something on another checkout. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** Where recordings live unless the caller names a file: gitignored, beside a README. */
export const RECORDINGS_DIR = resolve(REPO_ROOT, "docs/evaluations/recordings");

/** A path inside the repository as a relative one; anything else as given. */
function shownPath(path: string): string {
  const inside = relative(REPO_ROOT, path);
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : path;
}

/** What a replay is compared against: the recorded run's grade, or else the draft's saved assessment. */
export interface CvReplayBaseline {
  source: "recording" | "draft";
  /** Weighted coverage of the rubric by the printed CV (`CvAssessment.score`). */
  score: number;
  availableEvidenceScore: number;
  pageCount: number;
  /** Each essential requirement's points in the baseline, by id. */
  essentials: Record<string, number>;
}

/** The route one CV stage ran at: the registry's symbolic model, the model it resolved to, and the effort. */
export interface CvReplayRoute {
  model: string;
  resolvedModel: string;
  effort: Effort;
}

export interface CvReplayGrade {
  passed: boolean;
  invariants: {
    /** Every printed claim is supported by its own source. */
    claimsSupported: boolean;
    /** Weighted coverage is not lower than the baseline's; null without a baseline. */
    coverageNotLower: boolean | null;
    pageLimitMet: boolean;
    /** No essential requirement scores fewer points than in the baseline; null without a baseline. */
    noEssentialRegressed: boolean | null;
  };
  /** Essential requirements that lost points, with the points before and after. */
  regressions: Array<{ requirementId: string; before: number; after: number | null }>;
  score: number;
  availableEvidenceScore: number;
  pageCount: number;
  maxPages: number;
  /** The structural grader the build itself uses to judge a revision. */
  diagnostics: CvQualityDiagnostics;
}

export interface CvReplayReport {
  kind: "cv-replay";
  at: string;
  draftId: string;
  promptSetVersion: string;
  /**
   * True when the answers graded here did not come from the provider at this prompt set: served
   * from a recording made by an injected (scripted) client. A live run, or a replay of a live
   * recording, is not marked.
   */
  unverified: boolean;
  source: "recording" | "live";
  recording: string | null;
  /** The route each CV stage ran at, after the deployment's and the command's overrides. */
  routes: Record<string, CvReplayRoute>;
  /** The overrides the run was given (`--routes`), over the deployment's `stageRoutes`. */
  routeOverrides: StageRoutes;
  outcome: "published" | "failed";
  error: string | null;
  /** Requests the recording could not answer, by prompt and version. */
  misses: Array<Pick<RecordingKey, "promptId" | "promptVersion" | "stage">>;
  costUsd: number;
  calls: number;
  /** Calls and cost by ledger stage. */
  byStage: Record<string, { calls: number; costUsd: number }>;
  wallMs: number;
  /** Whether the optional improvement was adopted, so the graded CV is the revision rather than the baseline. */
  improvementAdopted: boolean;
  baseline: CvReplayBaseline | null;
  grade: CvReplayGrade | null;
}

const points = (assessment: CvAssessment, id: string) => {
  const match = assessment.review.matches.find(item => item.requirementId === id);
  return match ? cvMatchPoints(match.status) : null;
};

/** The figures a later run is held to, from a finished assessment. */
export function cvReplayBaseline(assessment: CvAssessment, source: CvReplayBaseline["source"]): CvReplayBaseline {
  return {
    source,
    score: assessment.score,
    availableEvidenceScore: assessment.availableEvidenceScore,
    pageCount: assessment.pageCount,
    essentials: Object.fromEntries(assessment.rubric.requirements
      .filter(item => item.importance === "essential")
      .map(item => [item.id, points(assessment, item.id) ?? 0])),
  };
}

/** Grade a rebuilt CV: the structural diagnostics, and the invariants a candidate must not break. */
export function gradeCvReplay(input: { assessment: CvAssessment; content: CvContent; baseline: CvReplayBaseline | null }): CvReplayGrade {
  const { assessment, content, baseline } = input;
  const maxPages = cvMaxPages(content.theme);
  const regressions = baseline ? Object.entries(baseline.essentials)
    .map(([requirementId, before]) => ({ requirementId, before, after: points(assessment, requirementId) }))
    .filter(item => item.after === null || item.after < item.before) : [];
  const invariants = {
    claimsSupported: assessment.review.claims.length > 0 && assessment.review.claims.every(claim => claim.status === "supported"),
    coverageNotLower: baseline ? assessment.score >= baseline.score : null,
    pageLimitMet: assessment.pageCount <= maxPages,
    noEssentialRegressed: baseline ? regressions.length === 0 : null,
  };
  return {
    passed: Object.values(invariants).every(value => value !== false),
    invariants, regressions,
    score: assessment.score, availableEvidenceScore: assessment.availableEvidenceScore,
    pageCount: assessment.pageCount, maxPages,
    diagnostics: diagnoseCvQuality(assessment, content),
  };
}

/** The deployment's stage routes with the command's laid over them, stage by stage and field by field. */
export function mergeStageRoutes(base: StageRoutes | null | undefined, over: StageRoutes | null | undefined): StageRoutes {
  const merged: StageRoutes = { ...(base ?? {}) };
  for (const [id, route] of Object.entries(over ?? {})) merged[id] = { ...(merged[id] ?? {}), ...(route ?? {}) };
  return merged;
}

/** The route each CV stage takes under `routes`, for a draft on `cvModel`. */
export function cvStageRoutes(routes: StageRoutes, cvModel: string): Record<string, CvReplayRoute> {
  return Object.fromEntries(CV_PROMPT_IDS.map(id => {
    const route = resolveRoute(PROMPTS[id], routes);
    return [id, { model: route.model, resolvedModel: routedModel(route, { cvModel }, cvModel), effort: route.effort }];
  }));
}

/** Rolls the run's transaction back, carrying what it found out. */
class Rollback<T> extends Error {
  constructor(readonly value: T) {
    super("replay rolled back");
  }
}

export interface CvReplayOptions {
  /** The model client: a `ReplayClient`, the provider, or a `RecordingClient` around either. */
  client: AiClientLike;
  /** Overrides laid over the deployment's `stageRoutes` for this run only. */
  routes?: StageRoutes;
  /** What the run is held to; defaults to the draft's saved assessment, when it has one. */
  baseline?: CvReplayBaseline | null;
  source: CvReplayReport["source"];
  recording?: string | null;
  unverified?: boolean;
}

/** The outcome of one rebuild, before it is written anywhere. */
export interface CvReplayRun {
  report: CvReplayReport;
  assessment: CvAssessment | null;
}

/**
 * Rebuild a draft through the real handler, in a transaction that is rolled back, and grade it.
 * Never throws for a build that failed: the report says so.
 */
export async function replayCvDraft(deps: WorkerDeps, draftId: string, options: CvReplayOptions): Promise<CvReplayRun> {
  const [draft] = await deps.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draftId));
  if (!draft) throw new Error(`No CV draft ${draftId}.`);
  const [plan] = await deps.db.select().from(schema.cvTailoringPlans).where(eq(schema.cvTailoringPlans.draftId, draftId));
  const deploymentRoutes = await Promise.resolve(deps.settings()).then(settings => settings.stageRoutes ?? {}).catch(() => ({}));
  const routes = mergeStageRoutes(deploymentRoutes as StageRoutes, options.routes);
  const baseline = options.baseline !== undefined ? options.baseline
    : draft.assessment ? cvReplayBaseline(draft.assessment, "draft") : null;

  const records: Array<{ stage: string; costUsd: number }> = [];
  const hold: AiHold = { release: async () => {}, consume: async () => {}, keep: () => {}, renew: async () => true, spent: 0, held: 0, limitUsd: Number.MAX_SAFE_INTEGER };
  const sink: CvBuildSink = {
    reserve: async () => hold,
    record: async usage => { records.push({ stage: usage.stage ?? "?", costUsd: usage.costUsd }); },
  };

  const started = Date.now();
  const at = deps.now().toISOString();
  type Found = { outcome: CvReplayReport["outcome"]; error: string | null; assessment: CvAssessment | null; content: CvContent | null; adopted: boolean };
  let found: Found;
  try {
    await deps.db.transaction(async tx => {
      const db = tx as unknown as Db;
      const now = deps.now();
      const [scratch] = await db.insert(schema.users).values({
        email: `replay-${randomUUID()}@replay.invalid`, name: "CV replay", role: "member", emailVerifiedAt: now, claimedAt: now,
      }).returning({ id: schema.users.id });
      const [copy] = await db.insert(schema.cvDrafts).values({
        userId: scratch!.id, jobTitle: draft.jobTitle, companyName: draft.companyName, jobDescription: draft.jobDescription,
        jobSource: draft.jobSource, libraryVersion: draft.libraryVersion, librarySnapshot: draft.librarySnapshot, model: draft.model,
        status: "queued", revision: 1,
        // The snapshot as it was built: the rubric its assessment was made against and the plan its
        // wording followed, so a replay compares like with like instead of re-deriving either.
        buildCheckpoint: {
          ...(draft.assessment?.rubric ? { sourceRubric: draft.assessment.rubric } : {}),
          ...(plan ? { tailoringEnabled: true, tailoringPlan: plan.plan } : {}),
          quizCompleted: true,
        },
      }).returning({ id: schema.cvDrafts.id });
      const account = await deps.userSettings(draft.userId);
      const replayDeps: WorkerDeps = {
        ...deps,
        db,
        aiClient: options.client,
        // The client is given, so the key is never used; the handler only asks that one exists.
        env: { ...deps.env, anthropicApiKey: deps.env.anthropicApiKey || "replay-client-given" },
        settings: async () => ({ ...(await deps.settings()), stageRoutes: routes }),
        userSettings: async () => ({ ...account, aiBudgetUsd: Number.MAX_SAFE_INTEGER, aiBudgetResetAt: null }),
      };
      const task = { id: null, type: "generate_cv", payload: { draftId: copy!.id, userId: scratch!.id }, attempts: 1, maxAttempts: 1 } as unknown as Task;
      const result = await handleGenerateCv(task, replayDeps, { signal: new AbortController().signal, sink }) as { failed?: boolean; error?: string };
      const [final] = await db.select().from(schema.cvDrafts)
        .where(and(eq(schema.cvDrafts.userId, scratch!.id), eq(schema.cvDrafts.status, "ready"), isNull(schema.cvDrafts.archivedAt)))
        .orderBy(desc(schema.cvDrafts.createdAt)).limit(1);
      const [row] = await db.select({ error: schema.cvDrafts.error, status: schema.cvDrafts.status }).from(schema.cvDrafts).where(eq(schema.cvDrafts.id, copy!.id));
      throw new Rollback<Found>(final?.assessment && final.content
        ? { outcome: "published", error: null, assessment: final.assessment, content: final.content, adopted: final.id !== copy!.id }
        : { outcome: "failed", error: result?.error ?? row?.error ?? `The rebuild ended ${row?.status ?? "without a CV"}.`, assessment: null, content: null, adopted: false });
    });
    throw new Error("The replay transaction committed; it must always roll back.");
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
    found = error.value as Found;
  }

  const byStage: CvReplayReport["byStage"] = {};
  for (const record of records) {
    const stage = byStage[record.stage] ??= { calls: 0, costUsd: 0 };
    stage.calls += 1;
    stage.costUsd = Number((stage.costUsd + record.costUsd).toFixed(6));
  }
  const misses = options.client instanceof ReplayClient ? options.client.misses : [];
  const report: CvReplayReport = {
    kind: "cv-replay", at, draftId, promptSetVersion: promptSetVersion(),
    unverified: options.unverified ?? false,
    source: options.source, recording: options.recording ? shownPath(options.recording) : null,
    routes: cvStageRoutes(routes, draft.model), routeOverrides: options.routes ?? {},
    outcome: found.outcome, error: found.error,
    misses: misses.map(({ promptId, promptVersion, stage }) => ({ promptId, promptVersion, stage })),
    costUsd: Number(records.reduce((sum, record) => sum + record.costUsd, 0).toFixed(6)),
    calls: records.length, byStage, wallMs: Date.now() - started,
    improvementAdopted: found.adopted,
    baseline,
    grade: found.assessment && found.content ? gradeCvReplay({ assessment: found.assessment, content: found.content, baseline }) : null,
  };
  return { report, assessment: found.assessment };
}

// ---------------------------------------------------------------------------------------------
// Recordings on disk.
// ---------------------------------------------------------------------------------------------

/** The first line of a recording: where it came from. */
interface RecordingMeta {
  kind: "meta";
  draftId: string;
  promptSetVersion: string;
  /** `provider` for a live recording; `injected` for one made through a stand-in client, such as a scripted one. */
  client: "provider" | "injected";
  routes: Record<string, CvReplayRoute>;
  at: string;
}

/** The last line of a recording: the recorded run's own grade, which a replay is held to. */
interface RecordingBaseline {
  kind: "baseline";
  baseline: CvReplayBaseline | null;
  report: CvReplayReport;
}

/** Read a recording's meta and baseline lines. */
export function readRecordingHeader(path: string): { meta: RecordingMeta | null; baseline: CvReplayBaseline | null } {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as { kind?: string });
  const meta = (lines.find(line => line.kind === "meta") as RecordingMeta | undefined) ?? null;
  const last = lines.filter((line): line is RecordingBaseline => line.kind === "baseline").at(-1);
  return { meta, baseline: last?.baseline ?? null };
}

export interface RecordCvOptions {
  /** The file to write; default `docs/evaluations/recordings/<draft>-<time>.jsonl`. */
  path?: string;
  routes?: StageRoutes;
}

/**
 * A live build of the draft through a recording client, into a recording a later replay can be
 * held to. Paid: it refuses without an API key, unless the deps carry a stand-in client (a test, or
 * the scripted fixture), which the recording then says it was made with.
 */
export async function recordCvDraft(deps: WorkerDeps, draftId: string, options: RecordCvOptions = {}): Promise<{ path: string; report: CvReplayReport }> {
  const injected = !!deps.aiClient;
  const apiKey = deps.env.anthropicApiKey;
  if (!injected && !apiKey) throw new Error("Recording is a live, paid build: set ANTHROPIC_API_KEY for the worker first.");
  const stamp = deps.now().toISOString().replace(/[:.]/g, "-");
  const path = resolve(options.path ?? resolve(RECORDINGS_DIR, `${draftId}-${stamp}.jsonl`));
  mkdirSync(dirname(path), { recursive: true });
  const [draft] = await deps.db.select({ model: schema.cvDrafts.model }).from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draftId));
  if (!draft) throw new Error(`No CV draft ${draftId}.`);
  const deploymentRoutes = await Promise.resolve(deps.settings()).then(settings => settings.stageRoutes ?? {}).catch(() => ({}));
  const meta: RecordingMeta = {
    kind: "meta", draftId, promptSetVersion: promptSetVersion(), client: injected ? "injected" : "provider",
    routes: cvStageRoutes(mergeStageRoutes(deploymentRoutes as StageRoutes, options.routes), draft.model), at: deps.now().toISOString(),
  };
  writeFileSync(path, JSON.stringify(meta) + "\n");
  const client = new RecordingClient(deps.aiClient ?? createProviderClient(apiKey!), { path, secrets: [apiKey] });
  const { report, assessment } = await replayCvDraft(deps, draftId, { client, routes: options.routes, source: "live", recording: path, unverified: injected });
  const line: RecordingBaseline = { kind: "baseline", baseline: assessment ? cvReplayBaseline(assessment, "recording") : null, report };
  appendFileSync(path, JSON.stringify(line) + "\n");
  return { path, report };
}

/** Replay a draft against a recording file: no key, no cost, and a miss fails the run naming what moved. */
export async function replayFromRecording(deps: WorkerDeps, draftId: string, path: string, routes?: StageRoutes): Promise<CvReplayRun> {
  const { meta, baseline } = readRecordingHeader(path);
  if (meta && meta.draftId !== draftId) throw new Error(`The recording is of draft ${meta.draftId}, not ${draftId}.`);
  return replayCvDraft(deps, draftId, {
    client: new ReplayClient(path), routes, source: "recording", recording: path,
    // A recording holds the recorded run's grade; without one, the draft's saved assessment is used.
    ...(baseline ? { baseline } : {}),
    unverified: meta?.client !== "provider",
  });
}
