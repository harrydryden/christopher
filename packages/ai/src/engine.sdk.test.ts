import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  createAiEngine, DEADLINE_ERROR_PREFIX, INTERRUPTED_ERROR_PREFIX, OUTPUT_LIMIT_ERROR, SCHEMA_ERROR_PREFIX,
  type AiClientLike, type AiUsageRecord,
} from "./engine";

/**
 * The engine driven through the real SDK client, with only `fetch` scripted.
 *
 * The fakes in engine.test.ts hand back a finished message, so they never exercise what the SDK
 * itself does with a request: it parses structured output inside the stream, and it retries a
 * failed request on its own. Both decide what the engine sees in production, so both are tested
 * here against the SDK the worker actually runs.
 */

/** One streamed answer, as the Messages API sends it: server-sent events around a single text block. */
function streamed(text: string, stop: { reason: string; details?: Record<string, unknown> }) {
  const events: Array<[string, Record<string, unknown>]> = [
    ["message_start", { type: "message_start", message: {
      id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-5", content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1 },
    } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta",
      delta: { stop_reason: stop.reason, stop_sequence: null, ...(stop.details ? { stop_details: stop.details } : {}) },
      usage: { output_tokens: 300 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** The provider saying it is overloaded, and when to try again. */
function overloaded(retryAfterMs: number) {
  return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), {
    status: 529, headers: { "content-type": "application/json", "retry-after-ms": String(retryAfterMs) },
  });
}

function sdkEngine(respond: (attempt: number) => Response) {
  const bodies: Array<Record<string, unknown>> = [];
  const client = new Anthropic({
    apiKey: "test-key",
    maxRetries: 2,
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return respond(bodies.length);
    },
  });
  const usage: AiUsageRecord[] = [];
  const engine = createAiEngine({ client: client as unknown as AiClientLike, getModel: () => "claude-sonnet-5", onUsage: record => { usage.push(record); } });
  return { engine, bodies, usage };
}

const JOB = { profileMarkdown: "", decisionDigest: "", job: { title: "Operations Manager", company: "Acme" } };
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("streamed answers through the SDK", () => {
  it("returns a valid answer, sending the schema without a parser the SDK would run", async () => {
    const { engine, bodies, usage } = sdkEngine(() => streamed('{"score":80,"verdict":"strong","rationale":"Fits.","flags":[]}', { reason: "end_turn" }));
    expect(await engine.scoreJob(JOB)).toMatchObject({ score: 80, verdict: "strong" });
    const format = (bodies[0]!.output_config as { format: Record<string, unknown> }).format;
    expect(format.type).toBe("json_schema");
    expect(format.schema).toBeTruthy();
    expect(bodies[0]!.stream).toBe(true);
    expect(usage[0]).toMatchObject({ ok: true, inputTokens: 1200, outputTokens: 300 });
  });

  it("names an answer cut off at the output ceiling, and records what it was billed", async () => {
    // The SDK used to parse this inside the stream and reject it as unparseable JSON, which the
    // engine could only call `unknown`: the CV policy for an output limit never ran.
    const { engine, usage } = sdkEngine(() => streamed('{"score":80,"verdict":"str', { reason: "max_tokens" }));
    expect(await engine.scoreJob(JOB)).toBeNull();
    expect(usage[0]).toMatchObject({ ok: false, error: OUTPUT_LIMIT_ERROR, failure: { kind: "output_limit" }, inputTokens: 1200, outputTokens: 300 });
    expect(usage[0]!.costUsd).toBeGreaterThan(0);
  });

  it("names a refusal the model wrote in prose", async () => {
    const { engine, usage } = sdkEngine(() => streamed("I can't help with that.", { reason: "refusal", details: { type: "refusal", category: "cyber", explanation: "x" } }));
    expect(await engine.scoreJob(JOB)).toBeNull();
    expect(usage[0]).toMatchObject({ ok: false, error: "refusal:cyber", failure: { kind: "refused" } });
  });

  it("names valid JSON the schema rejects, with the offending field", async () => {
    const { engine, usage } = sdkEngine(() => streamed('{"score":"high","verdict":"strong","rationale":"Fits."}', { reason: "end_turn" }));
    expect(await engine.scoreJob(JOB)).toBeNull();
    expect(usage[0]).toMatchObject({ ok: false, failure: { kind: "output_invalid" } });
    expect(usage[0]!.error!.startsWith(`${SCHEMA_ERROR_PREFIX} score:`)).toBe(true);
  });
});

describe("a paused server-tool turn through the SDK", () => {
  it("resolves the paused stream and resumes it, sending the turn back", async () => {
    const { engine, bodies, usage } = sdkEngine(attempt => attempt === 1
      ? streamed("Searching for similar companies.", { reason: "pause_turn" })
      : streamed(JSON.stringify({ candidates: [{ name: "Good Co", homepageUrl: "https://goodco.example", rationale: "Same sector.", confidence: 0.8 }] }), { reason: "end_turn" }));
    const found = await engine.suggestCompanies({ portfolio: [{ name: "Acme", domain: "acme.example" }], excludeDomains: [], rejected: [], limit: 5 });
    expect(found!.map(company => company.name)).toEqual(["Good Co"]);
    expect(bodies).toHaveLength(2);
    expect((bodies[1]!.messages as Array<{ role: string }>).map(message => message.role)).toEqual(["user", "assistant"]);
    expect(usage[0]).toMatchObject({ ok: true, inputTokens: 2400, outputTokens: 600 });
  });
});

describe("a call's signal reaches the SDK request", () => {
  it("retries an overloaded provider on its own when nothing stops it", async () => {
    const { engine, bodies, usage } = sdkEngine(() => overloaded(1));
    expect(await engine.scoreJob(JOB)).toBeNull();
    // Three attempts: the first and the SDK's two retries.
    expect(bodies).toHaveLength(3);
    expect(usage[0]!.failure).toEqual({ kind: "overloaded", status: 529 });
  });

  it("sends no retry once the caller's signal has aborted, and labels the stop as the worker's", async () => {
    const stop = new AbortController();
    const { engine, bodies, usage } = sdkEngine(() => {
      stop.abort(Object.assign(new Error("Task lease lost; another worker holds it"), { name: "LeaseLostError" }));
      return overloaded(1);
    });
    expect(await engine.scoreJob(JOB, { refType: "job", refId: "job-1", signal: stop.signal })).toBeNull();
    // Give the SDK its back-off: it wakes, sees the signal, and sends nothing more.
    await settle(50);
    expect(bodies).toHaveLength(1);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.error).toBe(`${INTERRUPTED_ERROR_PREFIX} Task lease lost; another worker holds it`);
    // Not a failure of the model's, and not a sibling's either.
    expect(usage[0]!.failure).toBeUndefined();
    expect(usage[0]).toMatchObject({ refType: "job", refId: "job-1" });
    expect(usage[0]).not.toHaveProperty("signal");
  });

  it("stops waiting at once rather than sleeping out the provider's retry-after", async () => {
    const run = new AbortController();
    const { engine, bodies, usage } = sdkEngine(() => {
      run.abort(Object.assign(new Error("score_job exceeded its 120s deadline after 120s and was abandoned"), { name: "TimeoutError" }));
      return overloaded(5_000);
    });
    const began = Date.now();
    expect(await engine.withSignal(run.signal).scoreJob(JOB)).toBeNull();
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(bodies).toHaveLength(1);
    // The deadline is named as the deadline, never as another call failing.
    expect(usage[0]!.error).toBe(`${DEADLINE_ERROR_PREFIX} score_job exceeded its 120s deadline after 120s and was abandoned`);
    expect(usage[0]!.failure).toBeUndefined();
  });
});
