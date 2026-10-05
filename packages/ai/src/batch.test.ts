/**
 * Background scoring through the Message Batches API, at the engine: the request a batch carries,
 * how it is held and priced, the one stream a submission takes, and recording and replaying it.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BATCH_ERROR_PREFIX, createAiEngine, type AiBatchesLike, type AiBatchLike, type AiBatchMeta, type AiBatchResultLike,
  type AiClientLike, type BatchResultContext, type ParseResponse, type ScoreJobInput,
} from "./engine";
import { AiGovernor } from "./governor";
import { BATCH_PRICE_MULTIPLIER, estimateBatchCostUsd, estimateCostUsd } from "./pricing";
import { PROMPTS } from "./prompt-registry";
import { RecordingClient, ReplayClient, readBatchRecording } from "./record-client";

const MODEL = "claude-sonnet-5";
const input: ScoreJobInput = {
  profileMarkdown: "# Profile\nOperations leader in climate hardware.",
  decisionDigest: "applied: Head of Ops at Volt",
  evidence: "Ran a 40-person ops team.",
  job: { title: "Head of Operations", company: "Acme", location: "London", description: "Lead operations." },
};
const answer = (over: Partial<ParseResponse> = {}): ParseResponse => ({
  parsed_output: { score: 82, verdict: "strong", rationale: "Operations leadership matches.", flags: [" Remote "] },
  usage: { input_tokens: 1_000, output_tokens: 120, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 0 },
  stop_reason: "end_turn", model: MODEL, ...over,
});

/** A batch resource that holds what it was sent until the test ends the batch with results. */
function fakeBatches() {
  const sent: Array<{ params: Parameters<AiBatchesLike["create"]>[0]; options?: Record<string, unknown>; meta?: AiBatchMeta }> = [];
  const batches = new Map<string, { batch: AiBatchLike; results: AiBatchResultLike[] }>();
  const resource: AiBatchesLike = {
    async create(params, options, meta) {
      sent.push({ params, options, meta });
      const batch: AiBatchLike = { id: `msgbatch_${sent.length}`, processing_status: "in_progress" };
      batches.set(batch.id, { batch, results: [] });
      return { ...batch };
    },
    async retrieve(id) { return { ...batches.get(id)!.batch }; },
    async results(id) {
      const results = batches.get(id)!.results;
      return { async *[Symbol.asyncIterator]() { yield* results; } };
    },
  };
  const end = (id: string, results: AiBatchResultLike[]) => {
    const held = batches.get(id)!;
    held.batch = { ...held.batch, processing_status: "ended" };
    held.results = results;
  };
  return { resource, sent, end };
}

function engineWith(batches?: AiBatchesLike, governor?: AiGovernor) {
  const live: Array<Record<string, unknown>> = [];
  const client: AiClientLike = {
    messages: { create: async params => { live.push(params); return answer(); }, ...(batches ? { batches } : {}) },
    beta: { messages: { create: async params => { live.push(params); return answer(); } } },
  };
  return { engine: createAiEngine({ client, getModel: () => MODEL, ...(governor ? { governor } : {}) }), live };
}

const context = (over: Partial<BatchResultContext> = {}): BatchResultContext => ({
  batchId: "msgbatch_1", model: MODEL, promptId: "A5", promptVersion: PROMPTS.A5.version,
  submittedAt: new Date("2026-09-27T10:00:00Z"), now: new Date("2026-09-27T10:40:00Z"), userId: "u1", jobId: "j1", ...over,
});

describe("an A5 request for a batch", () => {
  it("is the live request exactly, less the refusal fallback the Batches API refuses", async () => {
    const { engine, live } = engineWith(fakeBatches().resource);
    const multiLocation = { ...input, job: { ...input.job, location: undefined,
      locations: ["Atlanta, Georgia", "Boston, Massachusetts"] } };
    await engine.scoreJob(multiLocation);
    const { params, meta, model } = await engine.scoreJobBatchRequest(multiLocation);
    const { betas: _betas, fallbacks: _fallbacks, ...sentLive } = live[0]!;
    expect(params).toEqual(sentLive);
    expect(params).not.toHaveProperty("betas");
    expect(params).not.toHaveProperty("fallbacks");
    expect(params).not.toHaveProperty("stream");
    expect(meta).toEqual({ promptId: "A5", promptVersion: PROMPTS.A5.version });
    expect(model).toBe(MODEL);
    expect(JSON.stringify(params)).toContain("Boston, Massachusetts");
  });

  it("is held at the batch price, the account's context priced as a cache write and the output at its ceiling", async () => {
    const { engine } = engineWith(fakeBatches().resource);
    const { params, estimateUsd } = await engine.scoreJobBatchRequest(input);
    const content = (params.messages as Array<{ content: Array<{ text: string }> }>)[0]!.content;
    const tokens = (text: string) => Buffer.byteLength(text) / 3;
    const standard = estimateCostUsd(MODEL, {
      inputTokens: tokens(content[1]!.text),
      cacheWriteTokens: tokens(PROMPTS.A5.system) + tokens(content[0]!.text),
      cacheReadTokens: 0,
      outputTokens: PROMPTS.A5.maxTokens,
    });
    expect(estimateUsd).toBeCloseTo(standard * BATCH_PRICE_MULTIPLIER, 6);
    expect(estimateUsd).toBeGreaterThan(0);
  });
});

describe("the batch price", () => {
  it("halves every token, cache writes and reads included", () => {
    const usage = { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 5_000, cacheWriteTokens: 3_000, cacheWrite1hTokens: 1_000 };
    expect(estimateBatchCostUsd(MODEL, usage)).toBeCloseTo(estimateCostUsd(MODEL, usage) / 2, 6);
    expect(estimateBatchCostUsd(MODEL, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }))
      .toBeCloseTo(estimateCostUsd(MODEL, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }) / 2, 6);
  });
});

describe("submitting a batch", () => {
  it("sends every request under its custom_id, names each request's prompt beside it, and takes one stream", async () => {
    const fake = fakeBatches();
    const governor = new AiGovernor({ maxStreams: 1 });
    const { engine } = engineWith(fake.resource, governor);
    const request = await engine.scoreJobBatchRequest(input);
    // The only stream is taken: the submission waits for it.
    const held = await governor.acquire(MODEL, "interactive");
    const pending = engine.submitBatch([{ customId: "a", ...request }, { customId: "b", ...request }]);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fake.sent).toHaveLength(0);
    expect(governor.stats().queued).toBe(1);
    held();
    const batch = await pending;
    expect(batch.id).toBe("msgbatch_1");
    expect(fake.sent[0]!.params.requests.map(item => item.custom_id)).toEqual(["a", "b"]);
    expect(fake.sent[0]!.meta).toEqual({ requests: { a: request.meta, b: request.meta } });
    // The stream is given back once the batch is sent; reading it later takes none.
    expect(governor.stats().inFlight).toBe(0);
    await engine.retrieveBatch(batch.id);
    expect(governor.stats().inFlight).toBe(0);
  });

  it("refuses when the client has no batch resource", async () => {
    const { engine } = engineWith();
    expect(engine.supportsBatches).toBe(false);
    await expect(engine.submitBatch([{ customId: "a", ...(await engine.scoreJobBatchRequest(input)) }])).rejects.toThrow(/cannot send Message Batches/);
  });
});

describe("reading a batch result", () => {
  it("scores it as a live answer is scored, and records it at the batch price with the prompt it was sent with", () => {
    const { engine } = engineWith(fakeBatches().resource);
    const { score, record } = engine.readBatchScore(answer({ parsed_output: { score: 140, verdict: "possible", rationale: " Fits. ", flags: ["A", "a"] } }), context({ promptVersion: "sent-with" }));
    expect(score).toEqual({ score: 100, verdict: "strong", rationale: "Fits.", flags: ["a"] });
    const tokens = { inputTokens: 1_000, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 2_000 };
    expect(record).toMatchObject({
      callSite: "A5", model: MODEL, ...tokens, ok: true, promptId: "A5", promptVersion: "sent-with",
      userId: "u1", refType: "job", refId: "j1", requestId: "msgbatch_1", stopReason: "end_turn", durationMs: 40 * 60_000,
    });
    expect(record.costUsd).toBeCloseTo(estimateCostUsd(MODEL, tokens) / 2, 6);
  });

  it("records a refusal or a schema failure as a billed failed call, with no score", () => {
    const { engine } = engineWith(fakeBatches().resource);
    const refused = engine.readBatchScore(answer({ parsed_output: undefined, content: [], stop_reason: "refusal", stop_details: { category: "cyber" } }), context());
    expect(refused.score).toBeNull();
    expect(refused.record).toMatchObject({ ok: false, error: "refusal:cyber", failure: { kind: "refused" } });
    expect(refused.record.costUsd).toBeGreaterThan(0);
    const invalid = engine.readBatchScore(answer({ parsed_output: { score: "high" } }), context());
    expect(invalid.score).toBeNull();
    expect(invalid.record).toMatchObject({ ok: false, failure: { kind: "output_invalid" } });
    expect(invalid.record.error).toMatch(/^schema rejected:/);
  });

  it("records an errored request as a failure that cost nothing", () => {
    const { engine } = engineWith(fakeBatches().resource);
    const record = engine.batchErrorRecord({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, context());
    expect(record).toMatchObject({ ok: false, costUsd: 0, inputTokens: 0, outputTokens: 0, failure: { kind: "overloaded" }, promptId: "A5", userId: "u1" });
    expect(record.error).toBe(`${BATCH_ERROR_PREFIX} overloaded_error: Overloaded`);
  });
});

describe("recording and replaying a batch", () => {
  it("records the submission and every result under its prompt, and replays them without the provider", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "col-batch-recording-")), "calls.jsonl");
    const fake = fakeBatches();
    const recorder = new RecordingClient({ messages: { create: async () => answer(), batches: fake.resource } }, { path });
    const recording = createAiEngine({ client: recorder, getModel: () => MODEL });
    const request = await recording.scoreJobBatchRequest(input);
    const other = await recording.scoreJobBatchRequest({ ...input, job: { ...input.job, title: "COO" } });
    const batch = await recording.submitBatch([{ customId: "first", ...request }, { customId: "second", ...other }]);
    fake.end(batch.id, [
      { custom_id: "second", result: { type: "expired" } },
      { custom_id: "first", result: { type: "succeeded", message: answer() } },
    ]);
    // The results are read by another process: a fresh recorder on the same file still files them.
    const reader = createAiEngine({ client: new RecordingClient({ messages: { create: async () => answer(), batches: fake.resource } }, { path }), getModel: () => MODEL });
    const read: AiBatchResultLike[] = [];
    for await (const result of reader.batchResults(batch.id)) read.push(result);
    expect(read.map(result => result.custom_id)).toEqual(["second", "first"]);

    const lines = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as { kind: string });
    expect(lines.map(line => line.kind)).toEqual(["batch_submit", "batch_result", "batch_result"]);
    expect(readBatchRecording(path).map(line => [line.promptId, line.result.type])).toEqual([["A5", "expired"], ["A5", "succeeded"]]);

    // Replayed under new custom_ids — a replay's tasks have other ids — and a request never recorded misses.
    const replay = new ReplayClient(path);
    const replaying = createAiEngine({ client: replay, getModel: () => MODEL });
    const unseen = await replaying.scoreJobBatchRequest({ ...input, job: { ...input.job, title: "CFO" } });
    const again = await replaying.submitBatch([{ customId: "x", ...request }, { customId: "y", ...other }, { customId: "z", ...unseen }]);
    expect((await replaying.retrieveBatch(again.id)).processing_status).toBe("ended");
    const replayed = new Map<string, AiBatchResultLike["result"]>();
    for await (const result of replaying.batchResults(again.id)) replayed.set(result.custom_id, result.result);
    expect(replayed.get("x")).toMatchObject({ type: "succeeded", message: { parsed_output: { score: 82 } } });
    expect(replayed.get("y")).toEqual({ type: "expired" });
    expect(replayed.get("z")).toMatchObject({ type: "errored", error: { error: { type: "replay_miss" } } });
    expect(replay.misses).toHaveLength(1);
    expect(replay.hits).toBe(2);
    expect(fake.sent).toHaveLength(1);
  });
});
