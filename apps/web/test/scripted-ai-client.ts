/**
 * A scripted stand-in for the Anthropic client.
 *
 * It is injected as `WorkerDeps.aiClient`, so `handleGenerateCv` builds the real engine against it
 * and the whole CV pipeline runs for real: the shipped prompts, the streaming helper, the parallel
 * cached assessment batches, every validator, the page fitter and PDFKit. Only the model's words
 * are scripted, and they are scripted to be the answers a competent model would give — they must
 * survive `validateCvRubric`, `materialiseCv`, `cvBudgetViolations`, `reviewBatchIssues` and
 * `validateCvReview` without help.
 *
 * Every call is recorded with the exact params and options the engine sent, so a test can assert
 * what reached the model as well as what came back.
 */
import {
  CV_LIMITS,
  cvTailoringEvidence,
  cvRelevance,
  industryDescriptions,
  type CvBlockBudget,
  type CvLibrary,
  type CvPlan,
  type CvWritingBudget,
} from "@ava/core";
import type {
  CvClaimItem,
  CvReviewPlan,
  CvRubric,
  CvTextItem,
} from "@ava/core/cv-assessment";
// The interface does not depend on @ava/ai by name; the worker it drives does.
import type { AiClientLike, AiStreamLike } from "../../../packages/ai/src/index";
import { reviewFixture } from "../../../packages/core/test/cv-review-fixture";

type ParseResponse = Awaited<ReturnType<AiStreamLike["finalMessage"]>>;
type TextBlock = { type?: string; text: string; cache_control?: unknown };

/** The engine splits an audit into batches of this size; the fake predicts how many to expect. */
export const REVIEW_BATCH_SIZE = 8;

/** The improvement the scripted reviewer attaches to the requirement only the library covers. */
export const LIBRARY_ONLY_IMPROVEMENT =
  "Bring the confirmed supplier negotiation evidence into the CV instead of leaving it in the library.";

export type ScriptedCallKind = "rubric" | "planning" | "author" | "review";

interface PlanningPayload {
  rubric: CvRubric;
  evidence: Array<{ id: string; text: string; entryId?: string }>;
  destinations: {
    employment: Array<{ employmentId: string; label: string }>;
    evidence: Array<{ entryId: string; label: string; kind: string }>;
  };
}

export interface AuthorPayload {
  library: Omit<CvLibrary, "theme" | "name" | "contact" | "email" | "phone" | "location" | "linkedinUrl" | "websiteUrl">;
  jobTitle: string;
  company: string;
  description: string;
  rubric?: CvRubric;
  improvements?: string[];
  writingBudget: CvWritingBudget;
  maxPages: number;
  layoutFeedback?: {
    pageCount: number;
    maxPages: number;
    previousPlan: CvPlan;
    corrections?: string[];
  };
}

export interface ReviewPayload {
  cv: CvTextItem[];
  evidence: CvTextItem[];
  rubric: { caveats: string[] };
  requirements: CvRubric["requirements"];
  claims: CvClaimItem[];
  claimSources: CvTextItem[];
  corrections?: string[];
}

interface ScriptedBase {
  index: number;
  params: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
  system: string;
  blocks: TextBlock[];
}

export type ScriptedCall =
  | (ScriptedBase & { kind: "rubric"; payload: { description: string } })
  | (ScriptedBase & { kind: "planning"; payload: PlanningPayload })
  | (ScriptedBase & { kind: "author"; payload: AuthorPayload })
  | (ScriptedBase & { kind: "review"; payload: ReviewPayload });

/** Narrow the recorded log to one call site, keeping that site's payload type. */
export function callsOf<K extends ScriptedCallKind>(
  calls: readonly ScriptedCall[],
  kind: K,
): Array<Extract<ScriptedCall, { kind: K }>> {
  return calls.filter(
    (call): call is Extract<ScriptedCall, { kind: K }> => call.kind === kind,
  );
}

export interface ScriptedAiOptions {
  /**
   * A requirement whose quote matches is scripted as covered by the saved library but absent from
   * the printed CV, which is what makes its improvement system-owned. Must not be a global regex.
   */
  unmetRequirement?: RegExp;
  /** Cap on the requirements the scripted rubric returns. */
  maxRequirements?: number;
  /** How long an assessment's first batch waits for its siblings before giving up. */
  barrierMs?: number;
}

export interface ScriptedAiClient {
  client: AiClientLike;
  calls: ScriptedCall[];
  /** Ordered lifecycle log: `issue:`, `start:`, `end:`, `abort:`, `cancel:`, `barrier-timeout:`. */
  events: string[];
  /** The rubric the fake last wrote, which is also the one reused across revisions. */
  rubric(): CvRubric | undefined;
  reset(): void;
}

const clean = (value: string) => value.replace(/\s+/g, " ").trim();

/** Shorten to a word boundary. Never lengthens, never returns an empty string for real input. */
function clip(value: string, limit: number): string {
  const text = clean(value);
  if (limit <= 0) return text.slice(0, 1);
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  const trimmed = (space > Math.floor(limit / 2) ? cut.slice(0, space) : cut)
    .replace(/[\s,;:.–-]+$/u, "")
    .trim();
  return trimmed || cut.trim() || text.slice(0, Math.max(1, limit));
}

function lines(details: string): string[] {
  return details
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[•*-]\s+/, "").trim())
    .filter(Boolean);
}

/** Most relevant first, ties resolved by the stored order so a run is reproducible. */
function rank(values: readonly string[], target: string): string[] {
  return values
    .map((value, index) => ({ value, index, score: cvRelevance(value, target) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.value);
}

// -- the rubric (A: CV_RUBRIC_PROMPT) ---------------------------------------

const RUBRIC_SKIP =
  /^(we are hiring|we offer|apply |to apply)|\b(salary|pension|holiday|benefits?|equal opportunit)\b/i;
const RUBRIC_CUE =
  /\b(must|required?|require|minimum|at least|experience|degree|qualification|certif|you will|able to|desirable|preferred|familiar|hybrid|lead|own|partner|track|build|report)\b/i;

function importanceOf(sentence: string): CvRubric["requirements"][number]["importance"] {
  if (/\b(must|required|requires|minimum|at least)\b/i.test(sentence)) return "essential";
  if (/\b(preferred|desirable|bonus|ideally|nice to have)\b/i.test(sentence)) return "desirable";
  return "responsibility";
}

function categoryOf(sentence: string): CvRubric["requirements"][number]["category"] {
  if (/\b(degree|qualification|certif|education)\b/i.test(sentence)) return "education";
  if (/\b(hybrid|office|remote|travel|eligib|right to work|relocat)\b/i.test(sentence)) return "logistics";
  if (/\b(years|experience)\b/i.test(sentence)) return "experience";
  if (/\b(sql|erp|netsuite|tool|software|reporting|analytics|familiarity|skills?)\b/i.test(sentence))
    return "skills";
  return "delivery";
}

/**
 * A rubric of distinct requirements, each anchored to a verbatim contiguous sentence of the advert,
 * which is what `validateCvRubric` insists on. Benefits and employer boilerplate are left out.
 */
export function scriptedRubric(description: string, limit = 12): CvRubric {
  const sentences = description
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const requirements: CvRubric["requirements"] = [];
  for (const sentence of sentences) {
    if (requirements.length >= limit) break;
    if (sentence.length < 30 || sentence.length > 300) continue;
    if (RUBRIC_SKIP.test(sentence) || !RUBRIC_CUE.test(sentence)) continue;
    const key = clean(sentence).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    requirements.push({
      id: `r${requirements.length + 1}`,
      label: clip(sentence.split(/\s+/).slice(0, 9).join(" "), 90),
      quote: sentence,
      importance: importanceOf(sentence),
      category: categoryOf(sentence),
    });
  }
  if (!requirements.length)
    requirements.push({
      id: "r1",
      label: clip(description, 90),
      quote: clip(description, 300),
      importance: "essential",
      category: "experience",
    });
  return {
    requirements,
    caveats: [
      "The advert does not state the reporting line or the size of the operational budget, so scope is judged from the responsibilities only.",
    ],
  };
}

// -- the plan (B: CV_AUTHOR_PROMPT) -----------------------------------------

type Entry = AuthorPayload["library"]["entries"][number];

function sourceLines(entry: Entry): string[] {
  if (entry.kind === "experience" && entry.confirmedResponsibilities?.length)
    return entry.confirmedResponsibilities;
  if (entry.kind === "skill" && !entry.skillItems)
    return entry.details
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  return lines(entry.details);
}

/** Obey the block's own allocation: at most maxBullets, each within maxBulletCharacters. */
function fitBullets(source: readonly string[], block: CvBlockBudget, shorten: boolean): string[] {
  const perBullet = Math.max(1, Math.min(block.maxBulletCharacters, CV_LIMITS.bulletCharacters));
  const limit = shorten ? Math.max(40, Math.round((perBullet * 2) / 3)) : perBullet;
  const cap = Math.max(1, Math.min(limit, block.maxCharacters));
  const bullets: string[] = [];
  let used = 0;
  for (const line of source) {
    if (bullets.length >= block.maxBullets) break;
    const text = clip(line, cap);
    if (!text) continue;
    if (bullets.length && used + text.length > block.maxCharacters) break;
    bullets.push(text);
    used += text.length;
  }
  if (!bullets.length)
    bullets.push(
      clip(source[0] ?? "Delivered the confirmed responsibilities for this role.", cap),
    );
  return bullets;
}

/**
 * One section for every allocated experience and education block (omitting one fails the build by
 * design), skills chosen verbatim from the stored labels, and a profile within its own budget.
 */
export function scriptedPlan(payload: AuthorPayload): CvPlan {
  const { library, writingBudget, layoutFeedback } = payload;
  const target = `${payload.jobTitle} ${payload.description}`;
  const shorten = Boolean(layoutFeedback);
  const previous = new Map(
    (layoutFeedback?.previousPlan.sections ?? []).map((section) => [section.entryId, section]),
  );
  const evidence = cvTailoringEvidence(library as CvLibrary);
  const sections: CvPlan["sections"] = [];
  for (const block of writingBudget.blocks) {
    const entry = library.entries.find((candidate) => candidate.id === block.entryId);
    if (!entry) continue;
    const prior = previous.get(block.entryId);
    if (entry.kind === "skill" && entry.skillItems?.length && block.maxSkills > 0) {
      // Exact stored labels only; the renderer prints these as pills instead of the bullets.
      const chosen = rank(entry.skillItems, target).slice(0, block.maxSkills);
      sections.push({
        entryId: block.entryId,
        skillItems: chosen,
        bullets: chosen.slice(0, CV_LIMITS.bulletsPerSection),
        bulletSources: chosen.slice(0, CV_LIMITS.bulletsPerSection).map(label => {
          const source = evidence.find(item => item.entryId === entry.id && item.text === label)!;
          return [{ sourceId: source.id, quote: label }];
        }),
      });
      continue;
    }
    const bullets = fitBullets(
      prior?.bullets?.length ? prior.bullets : sourceLines(entry),
      block,
      shorten,
    );
    const job = library.employment?.find((item) => item.id === entry.employmentId);
    const industries = rank(industryDescriptions(job?.industryDescriptions), target).slice(0, 2);
    sections.push({
      entryId: block.entryId,
      bullets,
      bulletSources: bullets.map(bullet => {
        const source = evidence.find(item => item.entryId === entry.id && clean(item.text).includes(clean(bullet)))!;
        return [{ sourceId: source.id, quote: bullet }];
      }),
      ...(industries.length ? { industryDescriptions: industries } : {}),
    });
  }
  const summaryLimit = Math.max(
    1,
    Math.min(writingBudget.summaryCharacters, CV_LIMITS.summaryCharacters),
  );
  const summary = clip(layoutFeedback?.previousPlan.summary || library.profile, summaryLimit) || "Operations leader.";
  return {
    summary,
    summarySources: [{ sourceId: "source:profile", quote: summary }],
    sections,
    gaps: [],
  };
}

// -- the assessment (C: CV_REVIEW_PROMPT) -----------------------------------

/** A contiguous window around the match, so the quote stays verbatim in its source. */
function excerpt(text: string, pattern: RegExp): string {
  const at = text.search(pattern);
  if (at < 0) return clip(text.slice(0, 200), 200);
  return clean(text.slice(Math.max(0, at - 40), at + 140)).slice(0, 1600) || clip(text, 200);
}

export function scriptedReview(payload: ReviewPayload, unmet: RegExp): CvReviewPlan {
  const caveats = payload.rubric?.caveats ?? [];
  // A batch can carry requirements with no claims; the fixture needs a claim to cite.
  const review: CvReviewPlan =
    payload.requirements.length && !payload.claims.length
      ? {
          matches: payload.requirements.map((requirement) => ({
            requirementId: requirement.id,
            status: "unknown" as const,
            libraryStatus: "unknown" as const,
            cvEvidence: [],
            libraryEvidence: [],
            reason: "This batch carried no printed claims to assess against.",
            improvement: "",
          })),
          claims: [],
        }
      : reviewFixture({
          rubric: { requirements: payload.requirements, caveats },
          cv: payload.cv,
          claims: payload.claims,
          evidence: payload.evidence,
        });
  for (const match of review.matches) {
    const requirement = payload.requirements.find((item) => item.id === match.requirementId);
    if (!requirement || !unmet.test(requirement.quote)) continue;
    const source =
      payload.evidence.find((item) => item.id !== "source:profile" && unmet.test(item.text)) ??
      payload.evidence.find((item) => item.id !== "source:profile") ??
      payload.evidence[0];
    if (!source) continue;
    match.status = "missing";
    match.cvEvidence = [];
    match.libraryStatus = "demonstrated";
    match.libraryEvidence = [{ id: source.id, quote: excerpt(source.text, unmet) }];
    match.reason =
      "The saved evidence covers this requirement, but no printed line of the CV states it.";
    match.improvement = LIBRARY_ONLY_IMPROVEMENT;
  }
  return review;
}

// -- the client -------------------------------------------------------------

function kindOf(system: string): ScriptedCallKind {
  if (system.startsWith("Analyse the company")) return "rubric";
  if (system.startsWith("Map every supplied fixed rubric")) return "planning";
  if (system.includes("Write a tailored UK-English CV")) return "author";
  if (system.includes("Independently assess the exact final CV")) return "review";
  throw new Error(`Scripted client saw an unknown call site: ${system.slice(0, 80)}`);
}

function blocksOf(params: Record<string, unknown>): TextBlock[] {
  const messages = params.messages as Array<{ content: string | TextBlock[] }>;
  const content = messages[0]!.content;
  return typeof content === "string" ? [{ text: content }] : content;
}

function usageFor(kind: ScriptedCallKind, cached: boolean) {
  if (kind === "rubric" || kind === "planning")
    return { input_tokens: 1800, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  if (kind === "author")
    return { input_tokens: 4200, output_tokens: 2600, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  return {
    input_tokens: 600,
    output_tokens: 1400,
    cache_read_input_tokens: cached ? 5200 : 0,
    cache_creation_input_tokens: cached ? 0 : 5200,
  };
}

export function createScriptedAiClient(options: ScriptedAiOptions = {}): ScriptedAiClient {
  const unmet = options.unmetRequirement ?? /supplier negotiation/i;
  const barrierMs = options.barrierMs ?? 10_000;
  const calls: ScriptedCall[] = [];
  const events: string[] = [];
  let rubric: CvRubric | undefined;
  /** The batches of one assessment. The first waits here until the rest have been sent. */
  let group:
    | { expected: number; issued: number; release: () => void; waited: Promise<void> }
    | null = null;

  const expectedBatches = (payload: ReviewPayload) => {
    const claims = payload.cv.filter((item) => !item.id.endsWith(":heading")).length;
    const requirements = rubric?.requirements.length ?? payload.requirements.length;
    return Math.max(1, Math.ceil(Math.max(requirements, claims) / REVIEW_BATCH_SIZE));
  };

  const client: AiClientLike = {
    messages: {
      create: async () => {
        events.push("create-attempted");
        throw new Error("The engine must stream: a scripted client is never asked to create.");
      },
      stream(params: Record<string, unknown>, requestOptions?: Record<string, unknown>) {
        const index = calls.length;
        const system = (params.system as Array<{ text: string }>)[0]!.text;
        const kind = kindOf(system);
        const blocks = blocksOf(params);
        const payload = Object.assign({}, ...blocks.map((block) => JSON.parse(block.text)));
        calls.push({ index, kind, params, options: requestOptions, system, blocks, payload });
        events.push(`issue:${kind}:${index}`);

        let leader = false;
        let cached = false;
        if (kind === "review") {
          if (group) {
            group.issued += 1;
            cached = true;
            if (group.issued >= group.expected) group.release();
          } else {
            leader = true;
            let release!: () => void;
            const waited = new Promise<void>((resolve) => {
              release = resolve;
            });
            group = { expected: expectedBatches(payload as ReviewPayload), issued: 1, release, waited };
            if (group.issued >= group.expected) group.release();
          }
        }

        const gate = async () => {
          if (!leader || !group) return;
          const held = group;
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            held.waited,
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                events.push(`barrier-timeout:${index}`);
                resolve();
              }, barrierMs);
              timer.unref?.();
            }),
          ]);
          if (timer) clearTimeout(timer);
          if (group === held) group = null;
        };

        const respond = (): unknown => {
          if (kind === "rubric") {
            rubric = scriptedRubric(
              (payload as { description: string }).description,
              options.maxRequirements,
            );
            return rubric;
          }
          if (kind === "planning") {
            const planning = payload as PlanningPayload;
            const ask = planning.rubric.requirements.find(requirement => requirement.importance !== "responsibility" && requirement.category !== "logistics");
            const destination = planning.destinations.employment[0]
              ? { kind: "employment" as const, employmentId: planning.destinations.employment[0].employmentId }
              : { kind: "evidence" as const, entryId: planning.destinations.evidence[0]!.entryId };
            return {
              requirements: planning.rubric.requirements.map(requirement => ({
                requirementId: requirement.id,
                status: "missing" as const,
                evidence: [],
                reason: "The scripted planner leaves this for the factual audit.",
              })),
              gapQuestions: ask ? [{
                id: "q1", requirementId: ask.id, requirement: ask.label,
                prompt: "What further factual evidence can you add for this requirement?",
                suggestedDestination: destination,
              }] : [],
            };
          }
          if (kind === "author") return scriptedPlan(payload as AuthorPayload);
          return scriptedReview(payload as ReviewPayload, unmet);
        };

        const signal = requestOptions?.signal as AbortSignal | undefined;
        const listeners: Array<() => void> = [];
        let done = false;
        let cut = () => {};
        const stream = {
          currentMessage: undefined as ParseResponse | undefined,
          on(_event: "streamEvent", listener: () => void) {
            listeners.push(listener);
            return stream;
          },
          abort() {
            events.push(`abort:${index}`);
            cut();
          },
          finalMessage: () =>
            new Promise<ParseResponse>((resolve, reject) => {
              cut = () => {
                if (!done) reject(new Error("Request was aborted."));
              };
              signal?.addEventListener("abort", () => {
                if (done) return;
                events.push(`cancel:${index}`);
                cut();
              });
              Promise.resolve()
                .then(async () => {
                  // The response has begun: any prefix this call caches is now readable by others.
                  events.push(`start:${kind}:${index}`);
                  stream.currentMessage = { usage: { input_tokens: 400, cache_read_input_tokens: 0 } };
                  for (const listener of listeners) listener();
                  await gate();
                  return {
                    parsed_output: respond(),
                    usage: usageFor(kind, cached),
                    stop_reason: "end_turn",
                    model: params.model as string,
                  } satisfies ParseResponse;
                })
                .then(
                  (response) => {
                    done = true;
                    events.push(`end:${kind}:${index}`);
                    resolve(response);
                  },
                  (error) => {
                    done = true;
                    reject(error as Error);
                  },
                );
            }),
        };
        return stream satisfies AiStreamLike;
      },
    },
  };

  return {
    client,
    calls,
    events,
    rubric: () => rubric,
    reset() {
      calls.length = 0;
      events.length = 0;
      group = null;
    },
  };
}
