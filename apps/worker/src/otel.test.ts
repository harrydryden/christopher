/**
 * Tracing: off unless asked for, and when on, three kinds of span with nothing that names an account.
 * A real tracer provider with an in-memory exporter stands in for the OTLP collector.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import { node, tracing } from "@opentelemetry/sdk-node";
import { currentTraceId, otelEnabled, recordModelCall, samplerRatio, startOtel, traceHandlers, withSpan } from "./otel";
import { log } from "./log";

const exporter = new tracing.InMemorySpanExporter();
let provider: InstanceType<typeof node.NodeTracerProvider>;

beforeAll(() => {
  provider = new node.NodeTracerProvider({ spanProcessors: [new tracing.SimpleSpanProcessor(exporter)] });
  provider.register();
});
afterEach(() => exporter.reset());
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});

describe("whether tracing starts", () => {
  it("needs an explicit OTEL_SDK_DISABLED=false and an endpoint; the default is off", async () => {
    expect(otelEnabled({})).toBe(false);
    expect(otelEnabled({ OTEL_SDK_DISABLED: "true", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" })).toBe(false);
    expect(otelEnabled({ OTEL_SDK_DISABLED: "false" })).toBe(false);
    expect(otelEnabled({ OTEL_SDK_DISABLED: "False", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" })).toBe(true);
    await expect(startOtel({})).resolves.toBe(false);
  });

  it("samples 10 % unless told otherwise", () => {
    expect(samplerRatio({})).toBe(0.1);
    expect(samplerRatio({ OTEL_TRACES_SAMPLER_ARG: "0.25" })).toBe(0.25);
    expect(samplerRatio({ OTEL_TRACES_SAMPLER_ARG: "7" })).toBe(0.1);
    expect(samplerRatio({ OTEL_TRACES_SAMPLER_ARG: "" })).toBe(0.1);
  });
});

describe("the spans", () => {
  it("runs each task in a task.run span with its type, attempt and ready wait, and never its payload", async () => {
    const userId = "6d3f0c9e-5b1a-4a8e-9f3e-2c1d0b9a8f7e";
    const handlers = traceHandlers({ scan_company: async (task: { type: string; attempts: number; runAfter: Date; payload: unknown }) => `scanned ${task.type}` }, () => 10_000);
    await expect(handlers.scan_company({ type: "scan_company", attempts: 2, runAfter: new Date(7_500), payload: { userId, companyId: "c" } } as never)).resolves.toBe("scanned scan_company");
    const [span] = exporter.getFinishedSpans();
    expect(span!.name).toBe("task.run");
    expect(span!.attributes).toEqual({ "task.type": "scan_company", "task.attempt": 2, ready_wait_ms: 2_500 });
    expect(JSON.stringify(span!.attributes)).not.toContain(userId);
  });

  it("marks a span that throws as an error and rethrows", async () => {
    await expect(withSpan("scan.fetch", { "source.type": "greenhouse" }, async () => { throw new TypeError("boom"); })).rejects.toThrow("boom");
    const [span] = exporter.getFinishedSpans();
    expect(span!.status.code).toBe(2);
    expect(span!.attributes).toEqual({ "source.type": "greenhouse" });
  });

  it("records a model call back-dated by its duration, with model, call site and tokens only", () => {
    recordModelCall({ callSite: "CV", model: "model-a", stage: "author", inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 800, durationMs: 1_500, ok: false, failure: { kind: "rate_limited" }, userId: "u-1", refId: "draft-1" } as never, 10_000);
    const [span] = exporter.getFinishedSpans();
    expect(span!.name).toBe("model.call");
    expect(span!.attributes).toEqual({ "gen_ai.request.model": "model-a", call_site: "CV", stage: "author", input_tokens: 1_000, output_tokens: 200, cache_read_tokens: 800, status: "rate_limited" });
    const durationMs = span!.duration[0] * 1_000 + span!.duration[1] / 1e6;
    expect(Math.round(durationMs)).toBe(1_500);
  });

  it("puts the trace id on log lines written inside a recorded span, and none outside", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      let inside: string | undefined;
      await withSpan("task.run", {}, async () => { inside = currentTraceId(); log.info("inside"); });
      log.info("outside");
      const lines = write.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
      expect(lines[0]).toMatchObject({ msg: "inside", traceId: inside });
      expect(inside).toMatch(/^[0-9a-f]{32}$/);
      expect(lines[1].traceId).toBeUndefined();
    } finally { write.mockRestore(); }
  });
});
