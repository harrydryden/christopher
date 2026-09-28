/**
 * Every prompt the engine sends, as data.
 *
 * One entry per call site: its instructions, the schema its answer must fit, how hard the model is
 * asked to think, the most it may write, where the cache breakpoints sit and which model it runs
 * on. The engine takes an entry rather than loose parameters, so what a call site sends is written
 * down once, here, and every `ai_calls` row names the entry and the version of it that produced it.
 *
 * `version` is a short hash of the prompt text and its output schema, computed when this module
 * loads. Editing either changes the version, which is what lets a cost or quality shift be traced
 * to the prompt change that caused it, and what a build checkpoint pins (`promptSetVersion`).
 */
import { createHash } from "node:crypto";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { CvRubricSchema, CvReviewPlanSchema } from "@ava/core/cv-assessment";
import { CvPlanSchema, CvTailoringPlanOutputSchema, LibraryProposalSchema, LibraryReviewPlanSchema } from "@ava/core";
import { CV_AUTHOR_PROMPT, CV_REVIEW_PROMPT, CV_RUBRIC_PROMPT, CV_TAILORING_PROMPT } from "./cv-prompts";
import * as P from "./prompts";
import * as S from "./schemas";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * How long a cache entry lives. The provider requires the longer-lived breakpoints of a request to
 * come before the shorter-lived ones, so a layout is checked for that when this module loads.
 */
export type CacheTtl = "5m" | "1h";

/**
 * Where a call's cache breakpoints sit: optionally on the system prompt, then one per stable block
 * of the user turn, in order. `null` sends the block without a breakpoint. Whatever follows the
 * stable blocks — the volatile tail — is never cached.
 */
export interface CacheLayout {
  system: CacheTtl | null;
  stable: readonly (CacheTtl | null)[];
}

/**
 * Which model a call runs on. `callSite` is the deployment's choice for the call site (the admin's
 * per-call-site models); `cvModel` is the account's CV model, which the caller hands the engine;
 * anything else is a fixed model id.
 */
export type RouteModel = "callSite" | "cvModel" | (string & {});
export interface PromptRoute {
  model: RouteModel;
  effort: Effort;
}

/** An administrator's override of one entry's route; either field may be left to the default. */
export interface StageRouteOverride {
  model?: string;
  effort?: Effort;
}
export type StageRoutes = Partial<Record<string, StageRouteOverride>>;

export type PromptPriority = "interactive" | "background";

export interface PromptEntry {
  /** Stable name, recorded as `ai_calls.prompt_id`. */
  id: PromptId;
  /** What the ledger has always called this call site (A1–A12, or CV). */
  callSite: string;
  /** The step of a multi-call feature this entry is, recorded as `ai_calls.stage` unless the caller names one. */
  stage?: string;
  /** Short hash of `system` and the output schema, recorded as `ai_calls.prompt_version`. */
  version: string;
  system: string;
  schema: z.ZodType;
  /** The default effort: the same as `route.effort`, kept at the top level for reading. */
  effort: Effort;
  maxTokens: number;
  /** How long to wait for the response to begin. */
  timeoutMs: number;
  cacheLayout: CacheLayout;
  route: PromptRoute;
  /** Interactive work is let through the governor ahead of background work when streams are scarce. */
  priority: PromptPriority;
  tools?: ReadonlyArray<Record<string, unknown>>;
  /** What one call is calibrated to write, for estimates; `maxTokens` is the ceiling, not the expectation. */
  expectedOutputTokens: number;
}

/**
 * What a call writes at each effort, relative to `high`. Effort does not change the price of a
 * token; it changes how many the model spends thinking and writing, which are billed as output.
 * Each entry's `expectedOutputTokens` is calibrated at its own default effort, and an estimate for
 * a stage routed to another effort scales it by the ratio of these (`expectedOutputTokens`).
 *
 * These ratios are an assumption, not a measurement: no live run at a lower effort has been
 * recorded yet. Replace them from the output tokens a replay at that effort reports (docs/DEPLOY.md,
 * "Changing a stage's effort or model") once one has been run.
 */
export const EFFORT_OUTPUT_SCALE: Readonly<Record<Effort, number>> = { low: 0.45, medium: 0.7, high: 1, xhigh: 1.35, max: 1.75 };

/** What one call of `entry` is expected to write at `effort`: its calibration, scaled, within its ceiling. */
export function expectedOutputTokens(entry: PromptEntry, effort: Effort = entry.effort): number {
  return Math.min(entry.maxTokens, Math.round(entry.expectedOutputTokens * EFFORT_OUTPUT_SCALE[effort] / EFFORT_OUTPUT_SCALE[entry.effort]));
}

/** Assessment batches hold at most this many requirements and this many claims. */
export const CV_REVIEW_BATCH_SIZE = 8;

const CV_REVIEW_BATCH_PROMPT = CV_REVIEW_PROMPT + "\nThis is one batch of a larger audit. The user turn has three parts: the complete evidence library with the rubric's caveats, then the complete cv, then this batch: the rubric requirements and claims to assess now, with claimSources supplying each claim's required source explicitly. Assess only the batch's requirements and claims, using the complete CV and evidence as context. Return an empty array when the batch has no requirements or no claims. Use the shortest sufficient verbatim quotes; usually one or two sources per finding suffice. Leave improvement empty for a demonstrated requirement and reason empty for a supported claim: nothing reads them. Every other reason and improvement is one or two sentences, and an unsupported or uncertain claim must say why in at most 300 characters. Every claim with requiredEvidenceId must cite a verbatim quote from that exact source to be supported, including skills. Evidence from a different role, profile or skill block cannot substitute for it. If that source does not support the complete claim, mark it uncertain or unsupported; never copy in unrelated evidence merely to satisfy this rule.\nWhen the batch carries libraryVerdicts, the library side of each of its requirements is already settled by the evidence plan, which judged the confirmed evidence by the same rules: assess only the printed CV for status and cvEvidence, and do not return libraryStatus or libraryEvidence. Write each reason and improvement knowing what the library holds for that requirement, so an improvement points to the library evidence the CV leaves out, or asks for evidence the library lacks.";

/**
 * One batch's answer. The library side of a match is optional: a batch whose library side the
 * evidence plan settles is not asked for it, and the engine writes the plan's verdict on instead;
 * a batch without a plan that leaves it out is corrected (`reviewBatchIssues`).
 */
export const CvReviewBatchSchema = CvReviewPlanSchema.extend({
  matches: z.array(CvReviewPlanSchema.shape.matches.element.extend({
    libraryStatus: CvReviewPlanSchema.shape.matches.element.shape.libraryStatus.optional(),
    libraryEvidence: CvReviewPlanSchema.shape.matches.element.shape.libraryEvidence.optional(),
  })).max(CV_REVIEW_BATCH_SIZE),
  // A supported claim's reason may be empty; any other claim's is required (`reviewBatchIssues`).
  claims: z.array(CvReviewPlanSchema.shape.claims.element.extend({ reason: z.string().max(300) })).max(CV_REVIEW_BATCH_SIZE),
});

const SINGLE: CacheLayout = { system: "5m", stable: [] };
/**
 * The writer: the canonical library, then the role, then the volatile tail (the allocation, the
 * layout feedback, the improvements). Both stable blocks are cached for five minutes. An hour-long
 * write costs twice input against 1.25x, and pays back only when the next reader starts more than
 * five minutes after the last: measured, a build makes 1.14 author calls on average, and about 10 %
 * of consecutive CV calls are more than five minutes apart. The fitter's rewrites start as soon as
 * the previous answer ends, well inside five minutes of its start, and a cache read refreshes the
 * entry; only a late improvement misses, and it breaks even only if more than about 60 % did. The
 * system prompt has no marker of its own: the library's breakpoint already covers it.
 */
const WRITER_LAYOUT: CacheLayout = { system: null, stable: ["5m", "5m"] };
/**
 * The audit: the evidence and the rubric's caveats, then the printed CV, then the batch. Both are
 * cached for five minutes, which covers the batches of one audit: the first batch alone writes
 * them, and the rest go out once its response has begun. The re-audit of an improved CV usually
 * starts within five minutes of the last draft batch (the same measured call pattern as the
 * writer's), so the evidence is no longer written for an hour on the chance it does not. No system
 * marker, for the same reason as the writer's.
 */
const AUDIT_LAYOUT: CacheLayout = { system: null, stable: ["5m", "5m"] };
const WEB_SEARCH = (maxUses: number) => [{ type: "web_search_20260209", name: "web_search", max_uses: maxUses }];
/** A10's search allowance; its prompt names the same number. */
export const A10_MAX_SEARCHES = 8;

type Draft = Omit<PromptEntry, "version" | "effort" | "route" | "priority" | "timeoutMs" | "maxTokens" | "cacheLayout" | "expectedOutputTokens"> & {
  route: PromptRoute;
  priority?: PromptPriority;
  timeoutMs?: number;
  maxTokens?: number;
  cacheLayout?: CacheLayout;
  expectedOutputTokens?: number;
};

// --- the output format --------------------------------------------------------------------------

type JsonSchemaNode = Record<string, unknown>;

/** Keywords the SDK folds into a description that the provider's output grammar does enforce. */
const RESTORED_KEYWORDS = new Set(["enum", "const"]);

/**
 * Read the `{key: json, key: json}` text the SDK appends to a description for every keyword its
 * strict transform does not keep. Values are JSON, so a comma inside a string or an array is not a
 * separator; the scan tracks strings and brackets. Anything it cannot read returns null, and the
 * description is left as it was.
 */
function parseFoldedKeywords(text: string): Array<[string, unknown]> | null {
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  const body = text.slice(1, -1);
  const entries: Array<[string, unknown]> = [];
  let i = 0;
  while (i < body.length) {
    const key = /^([A-Za-z_$][\w$]*): /.exec(body.slice(i));
    if (!key) return null;
    i += key[0].length;
    const start = i;
    let depth = 0;
    let inString = false;
    for (; i < body.length; i++) {
      const ch = body[i]!;
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
      else if (depth === 0 && ch === "," && body[i + 1] === " ") break;
    }
    try {
      entries.push([key[1]!, JSON.parse(body.slice(start, i))]);
    } catch {
      return null;
    }
    if (i < body.length) i += 2;
  }
  return entries.length ? entries : null;
}

/** Move `enum` and `const` out of a node's description, where the SDK folded them, back onto the node. */
function restoreNode(node: JsonSchemaNode): void {
  const description = node.description;
  if (typeof description !== "string") return;
  const split = description.lastIndexOf("\n\n{");
  const prefix = split >= 0 ? description.slice(0, split) : "";
  const folded = split >= 0 ? description.slice(split + 2) : description;
  const entries = parseFoldedKeywords(folded);
  if (!entries || !entries.some(([key]) => RESTORED_KEYWORDS.has(key))) return;
  for (const [key, value] of entries) if (RESTORED_KEYWORDS.has(key)) node[key] = value;
  const kept = entries.filter(([key]) => !RESTORED_KEYWORDS.has(key));
  const rest = kept.length ? `{${kept.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(", ")}}` : "";
  const text = [prefix, rest].filter(Boolean).join("\n\n");
  if (text) node.description = text;
  else delete node.description;
}

function restoreKeywords(node: unknown): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) restoreKeywords(item);
    return;
  }
  const record = node as JsonSchemaNode;
  restoreNode(record);
  for (const key of ["properties", "$defs"]) {
    const children = record[key];
    if (children && typeof children === "object") for (const child of Object.values(children)) restoreKeywords(child);
  }
  for (const key of ["items", "anyOf", "allOf"]) restoreKeywords(record[key]);
}

export interface OutputFormat {
  type: "json_schema";
  schema: Record<string, unknown>;
}

/**
 * The output format a call sends, without the SDK's parser. The SDK's strict transform keeps only a
 * few keywords and folds the rest into the description as text, which drops `enum` and `const` from
 * the grammar although the provider enforces both: a `z.enum` field would otherwise be a free
 * string the model is only asked, in prose, to keep to. They are restored here, recursively; every
 * other folded keyword (lengths, bounds) stays description text, since the grammar does not take
 * it. This is the one place a format is built, for the request and for the prompt's version.
 */
export function outputFormat(schema: z.ZodType): OutputFormat {
  const { parse: _parse, ...format } = zodOutputFormat(schema);
  restoreKeywords(format.schema);
  return format as OutputFormat;
}

/** The prompt text and output contract as one short hash. */
export function promptVersion(system: string, schema: z.ZodType): string {
  const format = outputFormat(schema);
  return createHash("sha256").update(system).update("\0").update(JSON.stringify(format)).digest("hex").slice(0, 10);
}

function define(draft: Draft): PromptEntry {
  const entry: PromptEntry = {
    ...draft,
    version: promptVersion(draft.system, draft.schema),
    effort: draft.route.effort,
    maxTokens: draft.maxTokens ?? 4096,
    timeoutMs: draft.timeoutMs ?? 30_000,
    cacheLayout: draft.cacheLayout ?? SINGLE,
    priority: draft.priority ?? "background",
    expectedOutputTokens: draft.expectedOutputTokens ?? Math.min(draft.maxTokens ?? 4096, 2_000),
  };
  assertCacheLayout(entry.id, entry.cacheLayout);
  return entry;
}

const TTL_RANK: Record<CacheTtl, number> = { "1h": 2, "5m": 1 };

/** Throw when a layout would be refused: a shorter TTL before a longer one, or too many breakpoints. */
export function assertCacheLayout(id: string, layout: CacheLayout): void {
  const marks = [layout.system, ...layout.stable].filter((ttl): ttl is CacheTtl => ttl !== null);
  if (marks.length > 4) throw new Error(`${id}: at most four cache breakpoints may be declared, not ${marks.length}.`);
  for (let i = 1; i < marks.length; i++)
    if (TTL_RANK[marks[i]!] > TTL_RANK[marks[i - 1]!])
      throw new Error(`${id}: a ${marks[i]} cache breakpoint may not follow a ${marks[i - 1]} one; longer-lived entries come first.`);
}

export type PromptId =
  | "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "A7" | "A8" | "A9" | "A10" | "A10.sources" | "A11" | "A12"
  | "cv.rubric" | "cv.planning" | "cv.author" | "cv.improvement" | "cv.review" | "cv.review_candidate";

export const PROMPTS: Readonly<Record<PromptId, PromptEntry>> = {
  A1: define({ id: "A1", callSite: "A1", system: P.A1_CHOOSE_CAREERS_LINKS, schema: S.CareersLinksSchema,
    route: { model: "callSite", effort: "low" }, expectedOutputTokens: 300 }),
  A2: define({ id: "A2", callSite: "A2", system: P.A2_CLASSIFY_PAGE, schema: S.PageClassificationSchema,
    route: { model: "callSite", effort: "low" }, expectedOutputTokens: 200 }),
  // The ceiling is sized to the page by the caller (`a3OutputCeiling`); this is the cap it grows to.
  A3: define({ id: "A3", callSite: "A3", system: P.A3_EXTRACT_POSTINGS, schema: S.ExtractPostingsSchema,
    route: { model: "callSite", effort: "low" }, maxTokens: 32_000, timeoutMs: 60_000, expectedOutputTokens: 2_000 }),
  A4: define({ id: "A4", callSite: "A4", system: P.A4_CLEAN_DESCRIPTION, schema: S.DescriptionSchema,
    route: { model: "callSite", effort: "low" }, expectedOutputTokens: 150 }),
  // The account's own context is the stable block, cached ahead of the role being scored.
  A5: define({ id: "A5", callSite: "A5", system: P.A5_SCORE_JOB, schema: S.FitScoreSchema,
    route: { model: "callSite", effort: "low" }, maxTokens: 1024, cacheLayout: { system: "5m", stable: ["5m"] }, expectedOutputTokens: 200 }),
  A6: define({ id: "A6", callSite: "A6", system: P.A6_TAG_REASON, schema: S.ReasonTagsSchema,
    route: { model: "callSite", effort: "low" }, maxTokens: 1024, priority: "interactive", expectedOutputTokens: 150 }),
  A7: define({ id: "A7", callSite: "A7", system: P.A7_SYNTHESIZE_PROFILE, schema: S.ProfileSchema,
    route: { model: "callSite", effort: "high" }, maxTokens: 6000, timeoutMs: 60_000, expectedOutputTokens: 2_000 }),
  A8: define({ id: "A8", callSite: "A8", system: P.A8_SUGGEST_FILTERS, schema: S.FilterSuggestionsSchema,
    route: { model: "callSite", effort: "high" }, maxTokens: 4000, expectedOutputTokens: 500 }),
  A9: define({ id: "A9", callSite: "A9", system: P.A9_PROFILE_COMPANY, schema: S.CompanyProfileSchema,
    route: { model: "callSite", effort: "low" }, maxTokens: 2000, expectedOutputTokens: 300 }),
  // Eight searches, not fifteen: one search usually turns up several candidates, and each search's
  // results are re-sent as input on every later step of the turn (about 45 % of a run's cost).
  A10: define({ id: "A10", callSite: "A10", system: P.A10_SUGGEST_COMPANIES, schema: S.CompanySuggestionsSchema,
    route: { model: "callSite", effort: "high" }, maxTokens: 8000, timeoutMs: 60_000, tools: WEB_SEARCH(A10_MAX_SEARCHES), expectedOutputTokens: 2_000 }),
  "A10.sources": define({ id: "A10.sources", callSite: "A10", system: P.A10_EXTRACT_SOURCE_COMPANIES, schema: S.SourceCompaniesSchema,
    route: { model: "callSite", effort: "high" }, maxTokens: 8000, timeoutMs: 60_000, tools: WEB_SEARCH(5), expectedOutputTokens: 2_000 }),
  // A document is read once, so nothing of it is cached.
  A11: define({ id: "A11", callSite: "A11", system: P.A11_EXTRACT_LIBRARY, schema: LibraryProposalSchema,
    route: { model: "cvModel", effort: "low" }, maxTokens: 16_000, timeoutMs: 120_000, priority: "interactive", expectedOutputTokens: 1_500 }),
  A12: define({ id: "A12", callSite: "A12", stage: "review", system: P.A12_REVIEW_LIBRARY, schema: LibraryReviewPlanSchema,
    route: { model: "cvModel", effort: "low" }, maxTokens: 16_000, timeoutMs: 120_000, priority: "interactive",
    cacheLayout: { system: "5m", stable: ["5m"] }, expectedOutputTokens: 4_800 }),

  "cv.rubric": define({ id: "cv.rubric", callSite: "CV", stage: "rubric", system: CV_RUBRIC_PROMPT, schema: CvRubricSchema,
    // Thinking counts towards the ceiling; recorded rubrics reach 5.2k of the old 8k.
    route: { model: "cvModel", effort: "high" }, maxTokens: 12_000, timeoutMs: 120_000, priority: "interactive", expectedOutputTokens: 4_500 }),
  "cv.planning": define({ id: "cv.planning", callSite: "CV", stage: "planning", system: CV_TAILORING_PROMPT, schema: CvTailoringPlanOutputSchema,
    route: { model: "cvModel", effort: "high" }, maxTokens: 16_000, timeoutMs: 240_000, priority: "interactive", expectedOutputTokens: 6_000 }),
  "cv.author": define({ id: "cv.author", callSite: "CV", stage: "author", system: CV_AUTHOR_PROMPT, schema: CvPlanSchema,
    // Thinking counts towards the output ceiling, and recorded two-page builds have reached 15.6k
    // of the old 16k; it only has to stay above what a three-page plan can take.
    route: { model: "cvModel", effort: "high" }, maxTokens: 32_000, timeoutMs: 300_000, priority: "interactive",
    cacheLayout: WRITER_LAYOUT, expectedOutputTokens: 16_000 }),
  "cv.improvement": define({ id: "cv.improvement", callSite: "CV", stage: "improvement", system: CV_AUTHOR_PROMPT, schema: CvPlanSchema,
    route: { model: "cvModel", effort: "high" }, maxTokens: 32_000, timeoutMs: 300_000, priority: "interactive",
    cacheLayout: WRITER_LAYOUT, expectedOutputTokens: 16_000 }),
  "cv.review": define({ id: "cv.review", callSite: "CV", stage: "review", system: CV_REVIEW_BATCH_PROMPT, schema: CvReviewBatchSchema,
    // Recorded batches reach 11.8k of the old 16k ceiling; a truncated batch fails the audit.
    route: { model: "cvModel", effort: "high" }, maxTokens: 24_000, timeoutMs: 240_000, priority: "interactive",
    cacheLayout: AUDIT_LAYOUT, expectedOutputTokens: 7_000 }),
  "cv.review_candidate": define({ id: "cv.review_candidate", callSite: "CV", stage: "review_candidate", system: CV_REVIEW_BATCH_PROMPT, schema: CvReviewBatchSchema,
    route: { model: "cvModel", effort: "high" }, maxTokens: 24_000, timeoutMs: 240_000, priority: "interactive",
    cacheLayout: AUDIT_LAYOUT, expectedOutputTokens: 7_000 }),
};

export const PROMPT_IDS = Object.keys(PROMPTS) as PromptId[];
/** The CV builder's entries, in the order a build runs them. */
export const CV_PROMPT_IDS = ["cv.rubric", "cv.planning", "cv.author", "cv.improvement", "cv.review", "cv.review_candidate"] as const satisfies readonly PromptId[];

export function promptEntry(id: string): PromptEntry | undefined {
  return (PROMPTS as Record<string, PromptEntry>)[id];
}

export function isPromptId(id: string): id is PromptId {
  return Object.hasOwn(PROMPTS, id);
}

/** One hash of every entry's version: what a checkpoint pins so a resumed build knows the prompts moved. */
export function promptSetVersion(): string {
  const hash = createHash("sha256");
  for (const id of [...PROMPT_IDS].sort()) hash.update(`${id}:${PROMPTS[id].version}\n`);
  return hash.digest("hex").slice(0, 12);
}

/**
 * The route one call takes: the administrator's override for the entry when there is one, the
 * entry's own otherwise. An override naming no model keeps the entry's; one naming no effort does
 * the same. The model is still symbolic (`callSite`, `cvModel`) until the engine resolves it.
 */
export function resolveRoute(entry: PromptEntry, routes?: StageRoutes | null): PromptRoute {
  const override = routes?.[entry.id];
  return {
    model: override?.model ?? entry.route.model,
    effort: override?.effort && EFFORTS.includes(override.effort) ? override.effort : entry.route.effort,
  };
}

/** The model a route names, given what the symbolic names stand for on this call. */
export function routedModel(route: PromptRoute, names: { cvModel?: string; callSite?: string }, fallback: string): string {
  if (route.model === "cvModel") return names.cvModel ?? names.callSite ?? fallback;
  if (route.model === "callSite") return names.callSite ?? fallback;
  return route.model;
}

// --- layout -------------------------------------------------------------------------------------

export interface TextBlockParam {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: "1h" };
}

/** What one call sends: the stable blocks its layout declares, in order, then the volatile tail. */
export interface LayoutParts {
  stable?: readonly string[];
  tail?: string;
}

function cacheControl(ttl: CacheTtl | null): Pick<TextBlockParam, "cache_control"> {
  if (!ttl) return {};
  // A five-minute entry is the provider's default and is sent without a TTL, as it always was.
  return { cache_control: ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" } };
}

/**
 * The one rule for building a request: `[system][stable blocks…][volatile tail]`, with a
 * breakpoint wherever the entry's layout declares one. The cache is a prefix match, so everything
 * that varies between calls sharing a prefix goes in the tail, after every breakpoint.
 *
 * A call with no stable blocks sends its user turn as one string, as every single-shot call
 * always has.
 */
export function layoutFor(entry: PromptEntry, parts: LayoutParts): { system: TextBlockParam[]; content: string | TextBlockParam[] } {
  const stable = parts.stable ?? [];
  if (stable.length !== entry.cacheLayout.stable.length)
    throw new Error(`${entry.id} declares ${entry.cacheLayout.stable.length} stable block(s) but was given ${stable.length}.`);
  const system: TextBlockParam[] = [{ type: "text", text: entry.system, ...cacheControl(entry.cacheLayout.system) }];
  if (!stable.length) return { system, content: parts.tail ?? "" };
  const content: TextBlockParam[] = stable.map((text, index) => ({ type: "text", text, ...cacheControl(entry.cacheLayout.stable[index]!) }));
  if (parts.tail) content.push({ type: "text", text: parts.tail });
  return { system, content };
}

// --- the spec's table ---------------------------------------------------------------------------

const describeLayout = (layout: CacheLayout) =>
  [layout.system ? `system ${layout.system}` : "system uncached", ...layout.stable.map((ttl, i) => `stable ${i + 1} ${ttl ?? "uncached"}`), "tail uncached"].join(" · ");

/**
 * The rows of SPEC §4's table of CV call sites, generated from the entries so the document cannot
 * drift from what the engine sends. `registry.test.ts` holds the spec to this.
 */
export function cvCallSiteTable(): string {
  const rows = CV_PROMPT_IDS.map(id => {
    const entry = PROMPTS[id];
    const model = entry.route.model === "cvModel" ? "account's CV model" : entry.route.model;
    return `| \`${entry.id}\` | \`${entry.stage}\` | \`${entry.version}\` | ${model} | ${entry.effort} | ${entry.maxTokens.toLocaleString("en-GB")} | ${describeLayout(entry.cacheLayout)} |`;
  });
  return ["| Prompt | Stage | Version | Model | Effort | Max tokens | Cache layout |", "|---|---|---|---|---|---|---|", ...rows].join("\n");
}
