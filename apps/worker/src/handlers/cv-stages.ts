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
import {
  CV_REVIEW_BATCH_SIZE,
  PROMPTS,
  estimateStage,
  promptSetVersion as registryPromptSetVersion,
  type StageRoutes,
} from "@ava/ai";
import {
  CV_STAGE_ALLOWANCE_MS,
  type CvBuildCheckpoint,
  type CvBuildMotion,
  type CvBuildStageName,
} from "@ava/core";
import { CvBuildStop } from "@ava/core/cv-build-failure";
import type { CvClaimItem, CvRubric } from "@ava/core/cv-assessment";

/** The version of the prompts every checkpoint entry is pinned to: the model package's registry hash. */
export function promptSetVersion(): string {
  return registryPromptSetVersion();
}

/** What a CV build's stages are sized from. */
export interface CvStageSizes {
  libraryBytes: number;
  descriptionBytes: number;
  /** The printed CV an audit reads; about a two-page CV when unknown. */
  cvBytes?: number;
  /** For the audit stages: how many batches are still to run. */
  batches?: number;
}

/** The models a stage may be routed to: the draft's CV model and the administrator's stage routes. */
export interface CvStageModels {
  cvModel: string;
  routes?: StageRoutes | null;
}

/** The role block the writer caches after the library: the description, the rubric and the plan. */
const roleBytes = (sizes: CvStageSizes) => sizes.descriptionBytes * 2 + 4_000;
/** One writing call's volatile tail: the allocation, the layout feedback, the corrections. */
const WRITER_TAIL_BYTES = 6_000;
/** One audit batch's volatile tail: its slice of the rubric and its claims with their sources. */
const AUDIT_TAIL_BYTES = 7_500;
/** A two-page CV as the audit prints it. */
const PRINTED_CV_BYTES = 9_000;

/**
 * What one stage is expected to cost, at the model its registry entry is routed to, by the entry's
 * own cache layout (the model package's `estimateStage`). The writing is held for the fitter's
 * three attempts, the audit for the batches still to run; the improvement is one writing call.
 */
export function estimateCvStage(stage: CvBuildStageName, sizes: CvStageSizes, models: CvStageModels): number {
  const priced = { cvModel: models.cvModel, routes: models.routes ?? null };
  switch (stage) {
    case "rubric":
      return estimateStage(PROMPTS["cv.rubric"], { tailBytes: sizes.descriptionBytes }, priced);
    case "plan":
      return estimateStage(PROMPTS["cv.planning"], { tailBytes: sizes.libraryBytes + roleBytes(sizes) }, priced);
    case "write":
      return estimateStage(PROMPTS["cv.author"], { stableBytes: [sizes.libraryBytes, roleBytes(sizes)], tailBytes: WRITER_TAIL_BYTES, calls: 3 }, priced);
    case "improve":
      return estimateStage(PROMPTS["cv.improvement"], { stableBytes: [sizes.libraryBytes, roleBytes(sizes)], tailBytes: WRITER_TAIL_BYTES }, priced);
    case "audit":
    case "reaudit":
      return estimateStage(PROMPTS[stage === "audit" ? "cv.review" : "cv.review_candidate"], {
        stableBytes: [sizes.libraryBytes, sizes.cvBytes ?? PRINTED_CV_BYTES], tailBytes: AUDIT_TAIL_BYTES, calls: Math.max(1, sizes.batches ?? 1),
      }, priced);
  }
}

/** One batch of an audit: the requirements and claims it assesses. */
export interface CvAuditBatch {
  requirements: CvRubric["requirements"];
  claims: CvClaimItem[];
}

/**
 * The audit split into batches exactly as the engine splits it (`CV_REVIEW_BATCH_SIZE`, spread
 * evenly), so the build knows before it asks how many batches there are, which of them it already
 * holds, and which requirements each checks. The engine's `only` names batches by these indices.
 */
export function cvAuditBatches(input: { rubric: CvRubric; claims: CvClaimItem[] }, size = CV_REVIEW_BATCH_SIZE): CvAuditBatch[] {
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

  /**
   * The stop for a stage that ran past its allowance: a stalled stage, which the system retries from
   * the checkpoint. Thrown by `within` when the work throws on the way out, and by a caller whose
   * work returned normally with what it finished (the audit saves its finished batches first).
   */
  stalled(admission: CvBuildStageName, motion: CvBuildMotion): CvBuildStop {
    const minutes = Math.max(1, Math.round(this.allowance(admission) / 60_000));
    return new CvBuildStop("stalled",
      `The ${CV_STAGE_LABELS[admission]} step ran past its ${minutes}-minute allowance, so it was stopped. The next attempt resumes from what this build has already saved.`,
      { motion });
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
      if (timer.signal.aborted && !this.options.signal.aborted) throw this.stalled(admission, motion);
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
