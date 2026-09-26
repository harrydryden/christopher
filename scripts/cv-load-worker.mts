/**
 * The worker half of the CV load harness (scripts/cv-load.mjs starts it; do not run it by hand).
 *
 * It is the production worker's queue with the production handler map, abandonment hooks and CV
 * build slots (`cvConcurrency`, as apps/worker/src/index.ts sets it from CV_CONCURRENCY), against
 * a scripted model client instead of the provider. Only the model's words and its
 * timing are scripted: every build runs the shipped prompts through the real engine (streaming,
 * the batched cached assessment, the validators), the page fitter, PDFKit, the budget hold and its
 * renewals, the lease, the journal and the fenced writes.
 *
 * The scripted client is safe for concurrent builds, which the interface's test client is not (it
 * keeps one assessment barrier and one rubric for the whole process): each call is answered from
 * its own request alone, using that client's exported answer builders.
 *
 * Knobs (all set by the orchestrator):
 *   WORKER_CONCURRENCY   general slots, as in production (default 3)
 *   CV_CONCURRENCY       CV build slots, as in production (default 8)
 *   CV_LOAD_LATENCY_MS   "min-max" per model request, uniform (default 2000-6000)
 *   CV_LOAD_TTFB_SHARE   share of a request's latency before its first stream event (default 0.2)
 *   CV_LOAD_529_RATE     chance any one request attempt is answered 529 overloaded (default 0)
 *   CV_LOAD_GAP_QUIZ     "none" (default): the evidence planner asks no questions, so every build
 *                        runs straight through; "ask": it asks one and the build pauses
 *   CV_LOAD_EVENTS_PATH  where the JSON-lines event log goes
 *   CV_LOAD_QUEUE_POLL_MS the queue's idle poll (default 3000, the production default)
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { createDeps } from "../apps/worker/src/context";
import { readEnv } from "../apps/worker/src/env";
import { handlers, onAbandon, onInterrupted } from "../apps/worker/src/handlers";
import { TaskQueue, type TaskHandler } from "../apps/worker/src/queue";
import { InternalServerError, type AiClientLike, type AiStreamLike } from "../packages/ai/src/index";
import {
  scriptedPlan,
  scriptedReview,
  scriptedRubric,
  type AuthorPayload,
  type ReviewPayload,
} from "../apps/web/test/scripted-ai-client";
import { parseLatency } from "./cv-load.mjs";

type ParseResponse = Awaited<ReturnType<AiStreamLike["finalMessage"]>>;
type Kind = "rubric" | "planning" | "author" | "review";

const eventsPath = process.env.CV_LOAD_EVENTS_PATH ?? "/tmp/cv-load-events.jsonl";
writeFileSync(eventsPath, "");
const emit = (event: Record<string, unknown>) => appendFileSync(eventsPath, JSON.stringify({ at: Date.now(), ...event }) + "\n");

const latency = parseLatency(process.env.CV_LOAD_LATENCY_MS);
const ttfbShare = Math.min(0.9, Math.max(0, Number(process.env.CV_LOAD_TTFB_SHARE ?? 0.2)));
const overloadRate = Math.min(1, Math.max(0, Number(process.env.CV_LOAD_529_RATE ?? 0)));
const askQuestions = process.env.CV_LOAD_GAP_QUIZ === "ask";

/** The SDK's own retry policy for an error before the response begins: two retries, 0.5 s doubling to 8 s, up to 25% jitter. */
const SDK_RETRIES = 2;
const sdkDelay = (retry: number) => Math.min(500 * 2 ** retry, 8_000) * (1 - Math.random() * 0.25);

const stats = {
  requests: 0, byKind: { rubric: 0, planning: 0, author: 0, review: 0 } as Record<Kind, number>,
  overloadedAttempts: 0, sdkRetries: 0, overloadedCalls: 0, aborted: 0,
  activeStreams: 0, maxStreams: 0, activeWaiting: 0,
};

function kindOf(system: string): Kind {
  if (system.startsWith("Analyse the company")) return "rubric";
  if (system.startsWith("Map every supplied fixed rubric")) return "planning";
  if (system.includes("Write a tailored UK-English CV")) return "author";
  if (system.includes("Independently assess the exact final CV")) return "review";
  throw new Error(`The load harness saw a call site it does not script: ${system.slice(0, 80)}`);
}

function usageFor(kind: Kind, cached: boolean) {
  if (kind === "rubric" || kind === "planning") return { input_tokens: 1800, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  if (kind === "author") return { input_tokens: 4200, output_tokens: 2600, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  return { input_tokens: 600, output_tokens: 1400, cache_read_input_tokens: cached ? 5200 : 0, cache_creation_input_tokens: cached ? 0 : 5200 };
}

interface PlanningPayload {
  rubric: { requirements: Array<{ id: string; label: string; importance: string; category?: string }> };
  destinations: { employment: Array<{ employmentId: string }>; evidence: Array<{ entryId: string }> };
}

function answer(kind: Kind, payload: Record<string, unknown>): unknown {
  if (kind === "rubric") return scriptedRubric((payload as { description: string }).description);
  if (kind === "author") return scriptedPlan(payload as unknown as AuthorPayload);
  if (kind === "review") return scriptedReview(payload as unknown as ReviewPayload, /supplier negotiation/i);
  const planning = payload as unknown as PlanningPayload;
  const ask = askQuestions ? planning.rubric.requirements.find(r => r.importance !== "responsibility" && r.category !== "logistics") : undefined;
  const destination = planning.destinations.employment[0]
    ? { kind: "employment" as const, employmentId: planning.destinations.employment[0].employmentId }
    : { kind: "evidence" as const, entryId: planning.destinations.evidence[0]!.entryId };
  return {
    requirements: planning.rubric.requirements.map(r => ({ requirementId: r.id, status: "missing" as const, evidence: [], reason: "Scripted: left for the factual audit." })),
    gapQuestions: ask ? [{ id: "q1", requirementId: ask.id, requirement: ask.label, prompt: "What further factual evidence can you add for this requirement?", suggestedDestination: destination }] : [],
  };
}

/** Resolves after `ms`, or rejects at once when `signal` aborts. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Request was aborted."));
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error("Request was aborted.")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const overloaded = () => new InternalServerError(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded (injected by the load harness)" } }, undefined, new Headers());

const client: AiClientLike = {
  messages: {
    create: async () => { throw new Error("The engine must stream; the load harness never answers create."); },
    stream(params: Record<string, unknown>, requestOptions?: Record<string, unknown>) {
      const system = (params.system as Array<{ text: string }>)[0]!.text;
      const kind = kindOf(system);
      const content = (params.messages as Array<{ content: string | Array<{ text: string; cache_control?: unknown }> }>)[0]!.content;
      const blocks = typeof content === "string" ? [{ text: content }] : content;
      const payload = Object.assign({}, ...blocks.map(block => JSON.parse(block.text))) as Record<string, unknown>;
      const signal = requestOptions?.signal as AbortSignal | undefined;
      stats.requests++;
      stats.byKind[kind]++;
      const listeners: Array<() => void> = [];
      const cut = new AbortController();
      const both = signal ? AbortSignal.any([signal, cut.signal]) : cut.signal;
      const stream = {
        currentMessage: undefined as ParseResponse | undefined,
        on(_event: "streamEvent", listener: () => void) { listeners.push(listener); return stream; },
        abort() { cut.abort(); },
        finalMessage: async (): Promise<ParseResponse> => {
          // Before the response begins: the provider may answer 529, which the SDK retries twice.
          for (let attempt = 0; ; attempt++) {
            if (!(overloadRate > 0 && Math.random() < overloadRate)) break;
            stats.overloadedAttempts++;
            if (attempt >= SDK_RETRIES) { stats.overloadedCalls++; throw overloaded(); }
            stats.sdkRetries++;
            await wait(sdkDelay(attempt), both);
          }
          const total = latency.min + Math.random() * (latency.max - latency.min);
          stats.activeStreams++;
          stats.maxStreams = Math.max(stats.maxStreams, stats.activeStreams);
          try {
            await wait(total * ttfbShare, both);
            stream.currentMessage = { usage: { input_tokens: 400, cache_read_input_tokens: 0 } } as ParseResponse;
            for (const listener of listeners) listener();
            await wait(total * (1 - ttfbShare), both);
          } catch (error) {
            stats.aborted++;
            throw error;
          } finally {
            stats.activeStreams--;
          }
          const cached = kind === "review" && blocks.some(block => block.cache_control) && Math.random() < 0.9;
          return { parsed_output: answer(kind, payload), usage: usageFor(kind, cached), stop_reason: "end_turn", model: params.model as string } as ParseResponse;
        },
      };
      return stream as AiStreamLike;
    },
  },
};

async function main() {
  if (!process.env.ANTHROPIC_API_KEY?.startsWith("cv-load-scripted")) throw new Error("the load harness worker runs only with its placeholder key");
  const env = readEnv();
  const deps = await createDeps(env, { aiClient: client });
  const timed: TaskHandler = async (task, runDeps, ctx) => {
    const started = Date.now();
    const readyAt = Math.max(task.createdAt.getTime(), task.runAfter?.getTime() ?? 0);
    emit({ t: "claim", taskId: task.id, draftId: (task.payload as { draftId?: string }).draftId, attempt: task.attempts, readyWaitMs: Math.max(0, started - readyAt), createdAt: task.createdAt.getTime() });
    try {
      const result = await handlers.generate_cv!(task, runDeps, ctx);
      emit({ t: "end", taskId: task.id, draftId: (task.payload as { draftId?: string }).draftId, attempt: task.attempts, ms: Date.now() - started, result });
      return result;
    } catch (error) {
      emit({ t: "end", taskId: task.id, draftId: (task.payload as { draftId?: string }).draftId, attempt: task.attempts, ms: Date.now() - started, error: (error as Error).message?.slice(0, 300) });
      throw error;
    }
  };
  const queue = new TaskQueue(deps, { ...handlers, generate_cv: timed }, {
    concurrency: env.concurrency, cvConcurrency: env.cvConcurrency, workerId: env.workerId, onAbandon, onInterrupted,
    pollMs: Number(process.env.CV_LOAD_QUEUE_POLL_MS ?? 3000),
  });
  queue.start();
  emit({ t: "ready", concurrency: env.concurrency, cvCap: env.cvConcurrency, poolMax: env.databasePoolMax, latency, ttfbShare, overloadRate });
  const sampler = setInterval(() => {
    const memory = process.memoryUsage();
    emit({ t: "sample", streams: stats.activeStreams, active: queue.activeCount, heapMb: Math.round(memory.heapUsed / 1048576), rssMb: Math.round(memory.rss / 1048576) });
  }, 1_000);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(sampler);
    await queue.stop();
    emit({ t: "summary", ...stats });
    await deps.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}

await main();
