/**
 * The CV build's stage runner.
 *
 * A build is a handful of stages, each one or more model calls: the rubric, the evidence plan, the
 * writing, the audit (one stage per batch), and after publication the optional improvement and its
 * re-check. Each stage is described once — what it is called, which motion a failure in it belongs
 * to, what its result depends on, what it is expected to cost, how to run it and how to check what
 * came back — and the runner does the rest the same way for all of them:
 *
 *  - it looks the stage up in the build's checkpoint by a key made of its inputs, the prompt set
 *    and the model, and reuses a result made from the same three instead of paying for it again;
 *  - otherwise it admits the stage's own expected cost against the account's budget, immediately
 *    before the stage runs, and gives the hold back when the stage closes (the calls' real cost is
 *    taken off the hold as each is recorded, so what is released is only what was not spent);
 *  - it runs the stage under its own allowance as well as the build's signal, so one runaway stage
 *    is stopped at its allowance instead of spending the whole deadline;
 *  - it validates what came back and saves it under its key before anything else can go wrong.
 *
 * The checkpoint stays the draft's jsonb column, as `{ v: 2, promptSetVersion, stages }`; the
 * version 1 flags are written beside it as mirrors (see `CvBuildCheckpoint`).
 */
import { createHash } from "node:crypto";
import * as aiModule from "@ava/ai";
import { estimateCostUsd, type AiEngine, type AiFailure, type AiUsageRecord, type CvAssessBatchEvent, type Ref, type TokenUsage } from "@ava/ai";
import {
  CV_STAGE_ALLOWANCE_MS,
  type CvAuditPass,
  type CvBuildCheckpoint,
  type CvBuildMotion,
  type CvBuildStageName,
} from "@ava/core";
import { CvBuildStop } from "@ava/core/cv-build-failure";
import type { CvClaimItem, CvReviewPlan, CvRubric, CvTextItem } from "@ava/core/cv-assessment";

// ---------------------------------------------------------------------------------------------
// Adapters over the model package's next interface. Each is marked, and each is replaced by the
// package's own export when it lands; nothing else in the worker needs to change when it does.
// ---------------------------------------------------------------------------------------------

/**
 * ADAPTER (until the model package exports `promptSetVersion()`): the version of the prompts every
 * checkpoint entry is pinned to. The package's own function is used the moment it exists; until
 * then every build is on the one unversioned set, which is what the deployed prompts are.
 */
export function promptSetVersion(): string {
  const exported = (aiModule as unknown as { promptSetVersion?: () => string }).promptSetVersion;
  return typeof exported === "function" ? exported() : "unversioned";
}

/** What a CV build's stages are sized from: the two inputs every one of its calls reads. */
export interface CvStageSizes {
  libraryBytes: number;
  descriptionBytes: number;
  /** For the audit stages: how many batches are still to run. */
  batches?: number;
}

/** The most one author call is calibrated to write (recorded two-page builds reach 15.6k). */
const AUTHOR_OUTPUT_TOKENS = 16_000;
/** How many author calls one writing stage may make: the fitter's three attempts. */
const WRITING_ATTEMPTS = 3;

/**
 * ADAPTER (until the model package exports `estimateStage(entry, sizes)`): what one stage is
 * expected to cost, on the same calibration the whole-build estimate uses — the rubric reads the
 * description and writes about 4.5k tokens; the planner reads the library and description and
 * writes about 6k; the writer reads them again for each of its three attempts and writes up to 16k
 * each; each audit batch sends its slice of the rubric, reads the cached library and CV, and writes
 * about 7k, the first of them writing the cache.
 */
export function estimateStage(model: string, stage: CvBuildStageName, sizes: CvStageSizes): number {
  const library = sizes.libraryBytes / 3;
  const description = sizes.descriptionBytes / 3;
  const usage = (value: Partial<TokenUsage>): TokenUsage =>
    ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...value });
  switch (stage) {
    case "rubric":
      return estimateCostUsd(model, usage({ inputTokens: description, outputTokens: 4_500 }));
    case "plan":
      return estimateCostUsd(model, usage({ inputTokens: library + description + 1_500, outputTokens: 6_000 }));
    case "write":
      return estimateCostUsd(model, usage({ inputTokens: WRITING_ATTEMPTS * (library + description), outputTokens: WRITING_ATTEMPTS * AUTHOR_OUTPUT_TOKENS }));
    case "improve":
      return estimateCostUsd(model, usage({ inputTokens: library + description, outputTokens: AUTHOR_OUTPUT_TOKENS }));
    case "audit":
    case "reaudit": {
      const batches = Math.max(1, sizes.batches ?? 1);
      return estimateCostUsd(model, usage({
        inputTokens: batches * 2_500, cacheWriteTokens: library + 3_000,
        cacheReadTokens: (batches - 1) * library, outputTokens: batches * 7_000,
      }));
    }
  }
}

/** One batch of an audit: the requirements and claims it assesses. */
export interface CvAuditBatch {
  requirements: CvRubric["requirements"];
  claims: CvClaimItem[];
}

/**
 * ADAPTER (mirrors the engine's own `cvReviewBatches`, which it does not export): the audit split
 * into batches of at most eight requirements and claims, spread evenly. Assessing one of these on
 * its own sends exactly what the whole audit sends for it — the same cached evidence, rubric
 * caveats and CV, then the batch — so a batch run alone is the batch the whole audit would run.
 */
export function cvAuditBatches(input: { rubric: CvRubric; claims: CvClaimItem[] }, size = 8): CvAuditBatch[] {
  const count = Math.ceil(Math.max(input.rubric.requirements.length, input.claims.length) / size);
  const share = <T>(items: T[], index: number) => {
    const each = Math.ceil(items.length / count);
    return items.slice(index * each, (index + 1) * each);
  };
  return Array.from({ length: count }, (_, index) => ({
    requirements: share(input.rubric.requirements, index),
    claims: share(input.claims, index),
  }));
}

/**
 * ADAPTER (the shape the model package's `assessCv` will return per batch): how one batch of an
 * audit ended. `done` carries its findings; `failed` its error and classified failure; `cancelled`
 * is a sibling stopped because another batch failed, which is not a failure of its own.
 */
export interface CvAuditBatchResult {
  index: number;
  total: number;
  pass: CvAuditPass;
  status: "done" | "failed" | "cancelled";
  review?: CvReviewPlan;
  requirements: number;
  claims: number;
  usage?: AiUsageRecord;
  corrections?: number;
  error?: string;
  failure?: AiFailure;
}

/** One batch reporting on itself, in the audit's own numbering. */
export type CvAuditBatchEvent =
  | { index: number; total: number; phase: "start"; requirements: number; claims: number }
  | { index: number; total: number; phase: "retry"; usage?: AiUsageRecord; corrections?: number }
  | { index: number; total: number; phase: "done" | "failed" | "cancelled"; result: CvAuditBatchResult };

/** Why a sibling batch was stopped: another batch failed. Named so the engine records an interruption. */
class SiblingBatchFailed extends Error {
  constructor() {
    super("Another assessment batch failed, so this one was stopped.");
    this.name = "SiblingBatchFailed";
  }
}

/**
 * Run the batches of an audit that are not already held, one assessment call each.
 *
 * The first batch to run goes alone and the rest follow together, because the evidence and CV are
 * written to the cache by the first call and read by the others; this adapter cannot see the
 * moment the first answer begins, so it waits for the first batch to finish. A batch that fails
 * stops its siblings, which close as cancelled; a batch that finishes is handed to `onResult` at
 * once, so a later failure costs only the batches that did not finish.
 */
export async function runAuditBatches(options: {
  ai: AiEngine;
  input: { rubric: CvRubric; cv: CvTextItem[]; claims: CvClaimItem[]; evidence: CvTextItem[] };
  batches: CvAuditBatch[];
  pending: number[];
  pass: CvAuditPass;
  ref: Ref;
  signal: AbortSignal;
  onBatch: (event: CvAuditBatchEvent) => Promise<void>;
  onResult: (result: CvAuditBatchResult) => Promise<void>;
}): Promise<CvAuditBatchResult[]> {
  const { ai, input, batches, pass } = options;
  const total = batches.length;
  const siblings = new AbortController();
  const forward = () => siblings.abort(options.signal.reason);
  if (options.signal.aborted) forward(); else options.signal.addEventListener("abort", forward, { once: true });
  const results: CvAuditBatchResult[] = [];
  const runOne = async (index: number): Promise<CvAuditBatchResult> => {
    const batch = batches[index]!;
    const base = { index, total, pass, requirements: batch.requirements.length, claims: batch.claims.length };
    await options.onBatch({ index, total, phase: "start", requirements: base.requirements, claims: base.claims });
    let last: CvAssessBatchEvent | undefined;
    let review: CvReviewPlan | null = null;
    let error: string | undefined;
    try {
      review = await ai.assessCv(
        { rubric: { ...input.rubric, requirements: batch.requirements }, cv: input.cv, claims: batch.claims, evidence: input.evidence },
        { ...options.ref, signal: siblings.signal },
        {
          onBatch: async (event) => {
            last = event;
            if (event.phase === "retry")
              await options.onBatch({ index, total, phase: "retry", ...(event.usage ? { usage: event.usage } : {}),
                ...(event.corrections ? { corrections: event.corrections } : {}) });
          },
        },
      );
    } catch (thrown) {
      // The engine throws only when a batch came back without every requirement or claim it was
      // asked for; the CV is saved, so another assessment of this batch is all that is needed.
      error = (thrown as Error).message;
    }
    const usage = last?.usage;
    const corrections = last?.corrections;
    const extra = { ...(usage ? { usage } : {}), ...(corrections ? { corrections } : {}) };
    const result: CvAuditBatchResult = review
      ? { ...base, status: "done", review, ...extra }
      : siblings.signal.aborted && !error
        ? { ...base, status: "cancelled", ...extra }
        : { ...base, status: "failed", ...extra, ...(error ? { error } : {}), ...(usage?.failure ? { failure: usage.failure } : {}) };
    if (result.status === "failed" && !siblings.signal.aborted) siblings.abort(new SiblingBatchFailed());
    if (result.status === "done") await options.onResult(result);
    await options.onBatch({ index, total, phase: result.status, result });
    results[index] = result;
    return result;
  };
  try {
    const [first, ...rest] = options.pending;
    if (first === undefined) return results;
    const opening = await runOne(first);
    if (opening.status !== "done") return results;
    await Promise.all(rest.map(runOne));
    return results;
  } finally {
    options.signal.removeEventListener("abort", forward);
  }
}

// ---------------------------------------------------------------------------------------------
// The runner.
// ---------------------------------------------------------------------------------------------

/** What a stage is given to run with: the signal that stops it at its allowance or the build's stop. */
export interface CvStageContext {
  signal: AbortSignal;
}

/** One stage of a build, described once. */
export interface CvStage<I, O> {
  /** The checkpoint entry's name: `rubric`, `plan`, `write`, `audit[2]`. */
  name: string;
  /** The admission it is paid from, which also names its allowance. */
  admission: CvBuildStageName;
  /** The motion a failure in it is attributed to. */
  motion: CvBuildMotion;
  /** What its result depends on, besides the prompt set and the model the runner adds. */
  key(inputs: I): unknown;
  /** What it is expected to cost, in dollars. */
  estimate(inputs: I): number;
  run(inputs: I, ctx: CvStageContext): Promise<O>;
  /** Check a result, fresh or reused; throw a `CvBuildStop` when it cannot be used. */
  validate(output: O, inputs: I): O;
  /** Top-level version 1 fields to write beside the entry, for readers that know only those. */
  mirror?(output: O): Partial<CvBuildCheckpoint>;
}

/** A stage's hold on the budget: released when the stage closes. */
export interface CvStageHold {
  release(): Promise<void>;
}

/** The stage's name as a person reads it, for a refusal or a stopped stage. */
export const CV_STAGE_LABELS: Record<CvBuildStageName, string> = {
  rubric: "requirements analysis",
  plan: "evidence planning",
  write: "writing",
  audit: "assessment",
  improve: "optional improvement",
  reaudit: "re-check of the improvement",
};

/** Why a stage was stopped: it ran past its own allowance. Named so the engine records an interruption. */
class StageAllowanceExceeded extends Error {
  constructor(stage: CvBuildStageName, ms: number) {
    super(`The ${CV_STAGE_LABELS[stage]} step ran past its ${Math.round(ms / 60_000)}-minute allowance.`);
    this.name = "StageAllowanceExceeded";
  }
}

export interface CvStageRunnerOptions {
  /** The build's checkpoint as it stands, read each time: the handler moves it on too. */
  checkpoint: () => CvBuildCheckpoint;
  /** Write a new checkpoint to the draft, behind the build's fence. */
  persist: (checkpoint: CvBuildCheckpoint) => Promise<void>;
  /** Admit a stage's expected cost against the account's budget, or throw the refusal. */
  admit: (stage: CvBuildStageName, expectedUsd: number) => Promise<CvStageHold>;
  /** The build's own stop: a deadline, a lost lease, a released hold, a deleted draft. */
  signal: AbortSignal;
  model: string;
  promptSetVersion: string;
  now: () => Date;
  /** Per-stage allowances; the calibration constants unless a test shortens them. */
  allowanceMs?: Partial<Record<CvBuildStageName, number>>;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

export class CvStageRunner {
  /** Checkpoint writes, one after another, so two batches finishing together cannot lose either. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: CvStageRunnerOptions) {}

  /** The key a stage's result is saved under: its inputs, the prompt set and the model. */
  keyFor<I, O>(stage: CvStage<I, O>, inputs: I): string {
    return digest({ stage: stage.name, inputs: stage.key(inputs), prompts: this.options.promptSetVersion, model: this.options.model });
  }

  /** A saved result made from the same inputs, prompts and model, if it still validates. */
  lookup<I, O>(stage: CvStage<I, O>, inputs: I): O | undefined {
    const entry = this.options.checkpoint().stages?.[stage.name];
    if (!entry || entry.key !== this.keyFor(stage, inputs)) return undefined;
    try {
      return stage.validate(entry.value as O, inputs);
    } catch {
      return undefined;
    }
  }

  /** Save a stage's result under its key, with its mirrors, behind every earlier write. */
  async save<I, O>(stage: CvStage<I, O>, inputs: I, value: O, extra: Partial<CvBuildCheckpoint> = {}): Promise<void> {
    const write = this.writes.then(async () => {
      const current = this.options.checkpoint();
      await this.options.persist({
        ...current,
        ...(stage.mirror?.(value) ?? {}),
        ...extra,
        stages: { ...(current.stages ?? {}), [stage.name]: { key: this.keyFor(stage, inputs), at: this.options.now().toISOString(), value } },
      });
    });
    this.writes = write.catch(() => undefined);
    await write;
  }

  /** How long a stage of this admission may run. */
  allowance(admission: CvBuildStageName): number {
    return this.options.allowanceMs?.[admission] ?? CV_STAGE_ALLOWANCE_MS[admission];
  }

  /**
   * Run `work` under the stage's allowance as well as the build's stop. A stage stopped by its own
   * allowance is a stalled stage, which the system resolves by trying again from the checkpoint;
   * whatever the work threw on its way out is a consequence of the stop, not the reason.
   */
  async within<T>(admission: CvBuildStageName, motion: CvBuildMotion, work: (ctx: CvStageContext) => Promise<T>): Promise<T> {
    const ms = this.allowance(admission);
    const timer = new AbortController();
    const handle = setTimeout(() => timer.abort(new StageAllowanceExceeded(admission, ms)), ms);
    handle.unref?.();
    const signal = AbortSignal.any([this.options.signal, timer.signal]);
    try {
      return await work({ signal });
    } catch (error) {
      if (timer.signal.aborted && !this.options.signal.aborted)
        throw new CvBuildStop("stalled",
          `The ${CV_STAGE_LABELS[admission]} step ran past its ${Math.round(ms / 60_000)}-minute allowance, so it was stopped. The next attempt resumes from what this build has already saved.`,
          { motion });
      throw error;
    } finally {
      clearTimeout(handle);
    }
  }

  /** Admit, run under the allowance, and release whatever the stage did not spend. */
  async paid<T>(admission: CvBuildStageName, motion: CvBuildMotion, expectedUsd: number, work: (ctx: CvStageContext) => Promise<T>): Promise<T> {
    const hold = await this.options.admit(admission, expectedUsd);
    try {
      return await this.within(admission, motion, work);
    } finally {
      await hold.release();
    }
  }

  /**
   * One stage, start to finish: reuse a saved result made from the same inputs, prompts and model;
   * otherwise admit its cost, run it under its allowance, validate what came back and save it.
   */
  async run<I, O>(stage: CvStage<I, O>, inputs: I, options: { save?: boolean } = {}): Promise<{ value: O; reused: boolean }> {
    const saved = this.lookup(stage, inputs);
    if (saved !== undefined) return { value: saved, reused: true };
    const value = await this.paid(stage.admission, stage.motion, stage.estimate(inputs), async (ctx) =>
      stage.validate(await stage.run(inputs, ctx), inputs));
    if (options.save !== false) await this.save(stage, inputs, value);
    return { value, reused: false };
  }
}
