import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@anthropic-ai/sdk";
import { AiGovernor, BASE_PAUSE_MS, MAX_PAUSE_MS, maxStreamsFromEnv, retryAfterMs } from "./governor";
import { SERVER_FALLBACK_BETA, STREAM_CEILING_MS, createAiEngine, type AiClientLike, type AiStreamLike, type AiUsageRecord, type ParseResponse } from "./engine";

afterEach(() => { vi.useRealTimers(); });

const RUBRIC = { requirements: [{ id: "r1", label: "Ops", quote: "Lead operations", importance: "essential", category: "experience" }], caveats: [] };
const answer = (over: Partial<ParseResponse> = {}): ParseResponse => ({ parsed_output: RUBRIC, usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn", ...over });
const throttle = (headers: Record<string, string> = {}) =>
  new RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, undefined, new Headers(headers));

/**
 * A streaming client that emits one event when the response begins, then one every `everyMs`
 * until `respond` settles; the engine's clocks and aborts cut it off.
 */
function ticking(respond: (index: number) => Promise<ParseResponse>, everyMs?: number) {
  let n = 0;
  const client: AiClientLike = { messages: {
    create: () => Promise.reject(new Error("streams only")),
    stream(_params, options) {
      const index = n++;
      const signal = options?.signal as AbortSignal | undefined;
      const listeners: Array<() => void> = [];
      let timer: ReturnType<typeof setInterval> | undefined;
      let cut = () => {};
      const stream: AiStreamLike & { request_id: string } = {
        request_id: `req_${index}`,
        currentMessage: undefined,
        on(_event, listener) { listeners.push(listener); return stream; },
        abort() { cut(); },
        finalMessage: () => new Promise<ParseResponse>((resolve, reject) => {
          let done = false;
          cut = () => { clearInterval(timer); if (!done) reject(new Error("Request was aborted.")); };
          signal?.addEventListener("abort", () => cut());
          setTimeout(() => {
            for (const listener of listeners) listener();
            if (everyMs) timer = setInterval(() => { for (const listener of listeners) listener(); }, everyMs);
            respond(index).then(response => { done = true; clearInterval(timer); resolve(response); }, error => { done = true; clearInterval(timer); reject(error); });
          }, 250);
        }),
      };
      return stream;
    },
  } };
  return client;
}

describe("the stream governor", () => {
  it("caps the streams open per model, and lets interactive work through ahead of background work", async () => {
    const governor = new AiGovernor({ maxStreams: 1 });
    const order: string[] = [];
    const first = await governor.acquire("m", "background");
    const background = governor.acquire("m", "background").then(release => { order.push("background"); return release; });
    const interactive = governor.acquire("m", "interactive").then(release => { order.push("interactive"); return release; });
    // Another model has its own cap.
    const other = await governor.acquire("n");
    expect(governor.stats()).toMatchObject({ cap: 1, inFlight: 2, queued: 2, models: { m: { inFlight: 1, queued: 2 }, n: { inFlight: 1, queued: 0 } } });
    first();
    (await interactive)();
    (await background)();
    other();
    expect(order).toEqual(["interactive", "background"]);
    expect(governor.stats()).toMatchObject({ inFlight: 0, queued: 0 });
  });

  it("gives up waiting when the caller's signal aborts, leaving the queue as it was", async () => {
    const governor = new AiGovernor({ maxStreams: 1 });
    const held = await governor.acquire("m");
    const controller = new AbortController();
    const waiting = governor.acquire("m", "background", controller.signal);
    controller.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
    expect(governor.stats().queued).toBe(0);
    held();
    held(); // Releasing twice frees one place, not two.
    expect(governor.stats().inFlight).toBe(0);
  });

  it("holds every new request behind one shared pause after a throttle, as long as the provider asks, released with jitter", async () => {
    vi.useFakeTimers();
    const governor = new AiGovernor({ maxStreams: 4, random: () => 1 });
    expect(governor.noteThrottled(3_000)).toBe(3_000);
    let got = 0;
    const a = governor.acquire("m").then(release => { got++; return release; });
    const b = governor.acquire("m").then(release => { got++; return release; });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(got).toBe(0);
    // A quarter of the pause, at most two seconds, spreads the waiters out.
    await vi.advanceTimersByTimeAsync(752);
    await Promise.all([a, b]);
    expect(got).toBe(2);
  });

  it("doubles the pause for each throttle in a row, caps it, and starts again after a success", () => {
    let now = 0;
    const governor = new AiGovernor({ now: () => now });
    expect(governor.noteThrottled()).toBe(BASE_PAUSE_MS);
    now += 10_000;
    expect(governor.noteThrottled()).toBe(2 * BASE_PAUSE_MS);
    now += 10_000;
    expect(governor.noteThrottled(10 * 60_000)).toBe(MAX_PAUSE_MS);
    now += MAX_PAUSE_MS;
    governor.noteSuccess();
    expect(governor.noteThrottled()).toBe(BASE_PAUSE_MS);
  });

  it("reads the provider's wait from its headers, and the cap from the environment", () => {
    expect(retryAfterMs(new Headers({ "retry-after-ms": "1500" }))).toBe(1500);
    expect(retryAfterMs(new Headers({ "retry-after": "7" }))).toBe(7000);
    expect(retryAfterMs({ "retry-after": new Date(10_000).toUTCString() }, 4_000)).toBe(6_000);
    expect(retryAfterMs(new Headers())).toBeUndefined();
    expect(maxStreamsFromEnv({ AI_MAX_STREAMS: "6" })).toBe(6);
    expect(maxStreamsFromEnv({ AI_MAX_STREAMS: "zero" })).toBe(24);
    expect(maxStreamsFromEnv({})).toBe(24);
  });
});

describe("the engine under the governor", () => {
  it("retries a throttled request after the shared pause, and makes every other call wait it out too", async () => {
    vi.useFakeTimers();
    const governor = new AiGovernor({ random: () => 0 });
    const sent: number[] = [];
    let calls = 0;
    const client: AiClientLike = { messages: { create: async () => {
      calls++;
      sent.push(Date.now());
      if (calls === 1) throw throttle({ "retry-after-ms": "5000" });
      return answer();
    } } };
    const usage: AiUsageRecord[] = [];
    const engine = createAiEngine({ client, governor, retries: 2, getModel: () => "claude-sonnet-5", onUsage: record => { usage.push(record); } });
    const start = Date.now();
    const first = engine.analyseCvJob("Lead operations");
    await vi.advanceTimersByTimeAsync(0);
    // Sent after the throttle: waits for the same pause instead of trying now.
    const second = engine.analyseCvJob("Lead operations");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toEqual(RUBRIC);
    expect(await second).toEqual(RUBRIC);
    expect(sent.slice(1).every(at => at - start >= 5_000)).toBe(true);
    expect(usage.map(record => record.attempt).sort()).toEqual([1, 2]);
    expect(usage.every(record => record.ok)).toBe(true);
  });

  it("ends a call rather than wait past the minute its hold allows for back-off", async () => {
    const governor = new AiGovernor({ random: () => 0 });
    let calls = 0;
    const client: AiClientLike = { messages: { create: async () => { calls++; throw throttle({ "retry-after": "90" }); } } };
    const usage: AiUsageRecord[] = [];
    const engine = createAiEngine({ client, governor, retries: 2, getModel: () => "claude-sonnet-5", onUsage: record => { usage.push(record); } });
    expect(await engine.analyseCvJob("Lead operations")).toBeNull();
    expect(calls).toBe(1);
    expect(usage[0]).toMatchObject({ ok: false, attempt: 1, failure: { kind: "rate_limited", status: 429 } });
    // The pause still holds everyone else back.
    expect(governor.stats().pausedUntil).not.toBeNull();
  });

  it("holds each call to the stream cap, releasing its place once the call is recorded", async () => {
    const governor = new AiGovernor({ maxStreams: 1 });
    let open = 0, most = 0;
    const client: AiClientLike = { messages: { create: async () => {
      open++;
      most = Math.max(most, open);
      await new Promise(resolve => setTimeout(resolve, 5));
      open--;
      return answer();
    } } };
    const engine = createAiEngine({ client, governor, getModel: () => "claude-sonnet-5" });
    await Promise.all([engine.analyseCvJob("a"), engine.withSignal(new AbortController().signal).analyseCvJob("b"), engine.analyseCvJob("c")]);
    expect(most).toBe(1);
    expect(engine.governorStats()).toMatchObject({ cap: 1, inFlight: 0, queued: 0 });
  });

  it("records the time to the first event, the longest silence, the stop reason, the request id and the caller's step", async () => {
    vi.useFakeTimers();
    const client = ticking(() => new Promise(resolve => setTimeout(() => resolve(answer()), 10_000)), 3_000);
    const usage: AiUsageRecord[] = [];
    const engine = createAiEngine({ client, getModel: () => "claude-sonnet-5", onUsage: record => { usage.push(record); } });
    const pending = engine.analyseCvJob("Lead operations", { stepId: "step-9" });
    await vi.advanceTimersByTimeAsync(11_000);
    await pending;
    expect(usage[0]).toMatchObject({ ok: true, ttftMs: 250, maxEventGapMs: 3_000, stopReason: "end_turn", requestId: "req_0", attempt: 1, stepId: "step-9" });
  });

  it("keeps a stream that is still sending past the idle timeout, and cuts it off at the ceiling", async () => {
    vi.useFakeTimers();
    const client = ticking(() => new Promise(() => {}), 60_000);
    const usage: AiUsageRecord[] = [];
    const engine = createAiEngine({ client, getModel: () => "claude-sonnet-5", onUsage: record => { usage.push(record); } });
    const pending = engine.analyseCvJob("Lead operations");
    await vi.advanceTimersByTimeAsync(STREAM_CEILING_MS - 1_000);
    expect(usage).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toBeNull();
    expect(usage[0]).toMatchObject({ error: "Stream timed out: still open after 15 minutes.", failure: { kind: "stalled", stall: { reason: "ceiling", afterMs: STREAM_CEILING_MS } } });
  });

  it("uses a configured idle timeout, and says so in whole seconds when it is not whole minutes", async () => {
    vi.useFakeTimers();
    const client = ticking(() => new Promise(() => {}));
    const usage: AiUsageRecord[] = [];
    const engine = createAiEngine({ client, streamIdleMs: 90_000, getModel: () => "claude-sonnet-5", onUsage: record => { usage.push(record); } });
    const pending = engine.analyseCvJob("Lead operations");
    await vi.advanceTimersByTimeAsync(90_250);
    expect(await pending).toBeNull();
    expect(usage[0]!.error).toBe("Stream timed out: no events for 90 seconds.");
  });
});

describe("the server-side refusal fallback", () => {
  const withBeta = () => {
    const plain: Array<Record<string, unknown>> = [];
    const beta: Array<Record<string, unknown>> = [];
    const client: AiClientLike = {
      messages: { create: async params => { plain.push(params); return answer(); } },
      beta: { messages: { create: async params => { beta.push(params); return answer({ model: "claude-opus-4-8" }); } } },
    };
    return { client, plain, beta };
  };

  it("routes a model that supports it through the beta, asking for the provider's default fallback, and prices the model that answered", async () => {
    const { client, plain, beta } = withBeta();
    const usage: AiUsageRecord[] = [];
    await createAiEngine({ client, getModel: () => "claude-fable-5-1", onUsage: record => { usage.push(record); } }).analyseCvJob("Lead operations");
    expect(plain).toHaveLength(0);
    expect(beta[0]).toMatchObject({ model: "claude-fable-5-1", betas: [SERVER_FALLBACK_BETA], fallbacks: "default" });
    expect(usage[0]!.model).toBe("claude-opus-4-8");
  });

  it("sends a model without fallback targets, or an engine that turned it off, the ordinary way", async () => {
    const sonnet = withBeta();
    await createAiEngine({ client: sonnet.client, getModel: () => "claude-sonnet-5" }).analyseCvJob("Lead operations");
    expect(sonnet.beta).toHaveLength(0);
    expect(sonnet.plain[0]).not.toHaveProperty("fallbacks");
    const off = withBeta();
    await createAiEngine({ client: off.client, useServerFallback: false, getModel: () => "claude-fable-5-1" }).analyseCvJob("Lead operations");
    expect(off.beta).toHaveLength(0);
    expect(off.plain[0]).not.toHaveProperty("betas");
  });
});
