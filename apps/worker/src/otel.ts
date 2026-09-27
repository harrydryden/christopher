/**
 * Distributed tracing for the worker: three places latency hides — a task, a model call and a
 * source's fetch — plus every PostgreSQL query and outbound HTTP request under them, head-sampled at
 * 10 % and exported over OTLP.
 *
 * Off unless asked for. The SDK starts only when OTEL_SDK_DISABLED is set to "false" and
 * OTEL_EXPORTER_OTLP_ENDPOINT names a collector; otherwise this module loads nothing but the API,
 * whose tracer is a no-op, so the spans below cost a function call. Preloaded before the entry
 * point (`node --import tsx --import ./src/otel.ts src/index.ts`) so the pg and undici
 * instrumentations are in place before either is first loaded.
 *
 * Privacy: no account id, email, CV text, prompt or statement parameter is ever an attribute. The
 * pg instrumentation runs with enhancedDatabaseReporting off, so a span carries the statement text
 * (Drizzle and pg parameterise) and never its values.
 */
import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";

/** Whether this process should start the SDK: an explicit opt-in and somewhere to send spans. */
export function otelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "false" && !!env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
}

/** The head-sampling ratio: OTEL_TRACES_SAMPLER_ARG when it is a fraction, 0.1 otherwise. */
export function samplerRatio(env: NodeJS.ProcessEnv = process.env): number {
  const ratio = Number(env.OTEL_TRACES_SAMPLER_ARG);
  return Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 && env.OTEL_TRACES_SAMPLER_ARG?.trim() ? ratio : 0.1;
}

/** At most this many ended spans wait for export; beyond it they are dropped, not held in the heap. */
export const MAX_QUEUED_SPANS = 512;

let shutdown: (() => Promise<void>) | null = null;
let starting: Promise<boolean> | null = null;

/** Start the SDK once per process, when enabled; true when this call or an earlier one started it. */
export function startOtel(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!otelEnabled(env)) return Promise.resolve(false);
  starting ??= start(env);
  return starting;
}

async function start(env: NodeJS.ProcessEnv): Promise<boolean> {
  const [{ NodeSDK, tracing }, { OTLPTraceExporter }, { PgInstrumentation }, { UndiciInstrumentation }] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/instrumentation-pg"),
    import("@opentelemetry/instrumentation-undici"),
  ]);
  const sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME?.trim() || "ava-worker",
    sampler: new tracing.ParentBasedSampler({ root: new tracing.TraceIdRatioBasedSampler(samplerRatio(env)) }),
    spanProcessors: [new tracing.BatchSpanProcessor(new OTLPTraceExporter(), { maxQueueSize: MAX_QUEUED_SPANS })],
    instrumentations: [new PgInstrumentation({ enhancedDatabaseReporting: false }), new UndiciInstrumentation()],
  });
  sdk.start();
  shutdown = () => sdk.shutdown();
  process.once("beforeExit", () => void shutdown?.());
  return true;
}

/** Flush and stop the SDK, if it was started. Bounded by the caller. */
export async function stopOtel(): Promise<void> {
  await shutdown?.().catch(() => undefined);
  shutdown = null;
  starting = null;
}

const tracer = () => trace.getTracer("ava-worker");

/** Run `work` inside a span named `name`: ended however it settles, marked as an error if it throws. */
export async function withSpan<T>(name: string, attributes: Attributes, work: (span: Span) => Promise<T>): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error)?.name ?? "error" });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** The active span's trace id when it is being recorded, for log lines; undefined otherwise. */
export function currentTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  if (!span?.isRecording()) return undefined;
  return span.spanContext().traceId;
}

interface TaskLike { type: string; attempts: number; runAfter?: Date | null }

/**
 * Every handler wrapped in a `task.run` span with the task's type, attempt and how long it waited
 * ready. The payload is not an attribute: it carries account ids.
 */
export function traceHandlers<H extends Record<string, (task: never, ...rest: never[]) => Promise<unknown>>>(handlers: H, now: () => number = Date.now): H {
  return Object.fromEntries(Object.entries(handlers).map(([type, handler]) => [type, (task: TaskLike, ...rest: unknown[]) =>
    withSpan("task.run", {
      "task.type": task.type,
      "task.attempt": task.attempts,
      ...(task.runAfter ? { ready_wait_ms: Math.max(0, now() - task.runAfter.getTime()) } : {}),
    }, () => (handler as (task: TaskLike, ...rest: unknown[]) => Promise<unknown>)(task, ...rest))])) as unknown as H;
}

interface ModelCall {
  callSite: string; model: string; stage?: string; inputTokens: number; outputTokens: number; cacheReadTokens: number;
  durationMs: number; ok: boolean; failure?: { kind: string };
}

/**
 * One finished model call as a `model.call` span, back-dated to when it started: the engine reports
 * each call once, when it ends, with its duration. Model, call site, stage, token counts and
 * outcome only — never the account, the prompt or the answer.
 */
export function recordModelCall(call: ModelCall, now: number = Date.now()): void {
  const span = tracer().startSpan("model.call", {
    startTime: now - Math.max(0, call.durationMs),
    attributes: {
      "gen_ai.request.model": call.model,
      call_site: call.callSite,
      ...(call.stage ? { stage: call.stage } : {}),
      input_tokens: call.inputTokens,
      output_tokens: call.outputTokens,
      cache_read_tokens: call.cacheReadTokens,
      status: call.ok ? "ok" : call.failure?.kind ?? "error",
    },
  });
  if (!call.ok) span.setStatus({ code: SpanStatusCode.ERROR, message: call.failure?.kind ?? "error" });
  span.end(now);
}

// Preloaded with --import: start before the entry point loads pg or undici. A no-op when disabled,
// and once per process however many modules import this one.
await startOtel().catch((error) => {
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level: "warn", msg: "tracing did not start", data: { message: (error as Error)?.message } })}\n`);
  return false;
});
