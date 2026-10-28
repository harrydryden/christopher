import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import Anthropic from "../packages/ai/node_modules/@anthropic-ai/sdk/index.mjs";
import { installLiveEvaluationGuard, requestUpperBoundUsd } from "./live-evaluation-guard.mjs";

const guards = [];
afterEach(() => { for (const guard of guards.splice(0).reverse()) guard.restore(); });
const install = options => {
  const guard = installLiveEvaluationGuard({ model: "claude-fable-5-1", maxUsd: 10,
    phases: { cv: { maxUsd: 6, maxRequests: 5 }, skills: { maxUsd: 2, maxRequests: 2 } }, ...options });
  guards.push(guard);
  return guard;
};
const body = (max_tokens = 100) => JSON.stringify({ model: "claude-fable-5-1", max_tokens, messages: [{ role: "user", content: "Fixture" }] });

test("rejects wrong models, tools and unbounded output", () => {
  assert.throws(() => requestUpperBoundUsd(JSON.stringify({ model: "other", max_tokens: 100 }), "claude-fable-5-1"));
  assert.throws(() => requestUpperBoundUsd(JSON.stringify({ model: "claude-fable-5-1", max_tokens: 100, tools: [] }), "claude-fable-5-1"));
  assert.throws(() => requestUpperBoundUsd(body(32_001), "claude-fable-5-1"));
  assert.throws(() => requestUpperBoundUsd(JSON.stringify({ model: "claude-fable-5-1", max_tokens: 100,
    messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.test/tiny" } }] }] }),
  "claude-fable-5-1"), /text-only/);
  assert.throws(() => requestUpperBoundUsd('{"secret":', "claude-fable-5-1"), /^Error: Evaluation request body is not valid JSON\.$/);
});

test("debits before forwarding, counts failures and SDK retry attempts, and blocks other destinations", async () => {
  let forwards = 0;
  const guard = install({ forward: async () => { forwards++; throw new Error("synthetic transport failure"); } });
  guard.setPhase("skills");
  await assert.rejects(fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: body() }), /synthetic transport failure/);
  await assert.rejects(fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: body() }), /synthetic transport failure/);
  await assert.rejects(fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: body() }), /spend ceiling/);
  await assert.rejects(fetch("https://evil.example/v1/messages", { method: "POST", body: body() }), /unexpected outbound request/);
  assert.equal(forwards, 2);
  assert.equal(guard.snapshot().attempts.skills, 2);
  assert.ok(guard.snapshot().upperBoundsUsd.skills > 0);
});

test("the real SDK captures the guarded fetch without a client substitution", async () => {
  let forwarded = 0;
  const guard = install({ forward: async () => {
    forwarded++;
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "synthetic" } }),
      { status: 400, headers: { "content-type": "application/json" } });
  } });
  guard.setPhase("cv");
  const client = new Anthropic({ apiKey: "synthetic-key", maxRetries: 0 });
  await assert.rejects(client.messages.create({ model: "claude-fable-5-1", max_tokens: 100, messages: [{ role: "user", content: "Fixture" }] }));
  assert.equal(forwarded, 1);
  assert.equal(guard.snapshot().attempts.cv, 1);
});

test("an SDK client constructed before the guard bypasses it, so setup order matters", async () => {
  const original = globalThis.fetch;
  let earlyCalls = 0;
  globalThis.fetch = async () => {
    earlyCalls++;
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "synthetic" } }),
      { status: 400, headers: { "content-type": "application/json" } });
  };
  let guard;
  try {
    const earlyClient = new Anthropic({ apiKey: "synthetic-key", maxRetries: 0 });
    guard = install({ forward: async () => { throw new Error("must not forward"); } });
    guard.setPhase("cv");
    await assert.rejects(earlyClient.messages.create({ model: "claude-fable-5-1", max_tokens: 100,
      messages: [{ role: "user", content: "Fixture" }] }));
    assert.equal(earlyCalls, 1);
    assert.equal(guard.snapshot().attempts.cv, 0);
  } finally {
    guard?.restore();
    if (guard) guards.splice(guards.indexOf(guard), 1);
    globalThis.fetch = original;
  }
});

test("forces redirect errors on every forwarded transport attempt", async () => {
  let redirect;
  const guard = install({ forward: async (_input, init) => {
    redirect = init.redirect;
    return new Response(null, { status: 204 });
  } });
  guard.setPhase("cv");
  await fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: body() });
  assert.equal(redirect, "error");
  assert.deepEqual(guard.snapshot().events.at(-1), { phase: "cv", attempt: 1, kind: "response", status: 204,
    upperBoundUsd: requestUpperBoundUsd(body(), "claude-fable-5-1"), complete: false });
});

test("settles only a complete provider stream using token usage and keeps error content out of diagnostics", async () => {
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"private synthetic answer"}}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  ].join("\n\n") + "\n\n";
  const guard = install({ forward: async () => new Response(sse, { status: 200,
    headers: { "content-type": "text/event-stream" } }) });
  guard.setPhase("cv");
  await fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: body() });
  const snapshot = guard.snapshot();
  assert.equal(snapshot.attempts.cv, 1);
  assert.ok(Math.abs(snapshot.totalUpperBoundUsd - 0.0015) < 0.000001);
  assert.equal(snapshot.events.at(-1).kind, "settled");
  assert.ok(!JSON.stringify(snapshot).includes("private synthetic answer"));
});

test("carries prior conservative debit into a retry and records only safe error codes", async () => {
  const persisted = [];
  const guard = install({ prior: { totalUpperBoundUsd: 4.15224,
    upperBoundsUsd: { fixture: 0, cv: 4.15224, skills: 0 }, attempts: { fixture: 0, cv: 2, skills: 0 } },
    phases: { cv: { maxUsd: 10, maxRequests: 5 }, skills: { maxUsd: 2, maxRequests: 2 } },
    onDebit: snapshot => persisted.push(snapshot),
    forward: async () => { const error = new Error("secret request text"); error.code = "ECONNRESET"; throw error; } });
  guard.setPhase("cv");
  await assert.rejects(fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: body() }));
  assert.equal(guard.snapshot().attempts.cv, 3);
  assert.ok(guard.snapshot().totalUpperBoundUsd > 4.15224);
  assert.deepEqual(guard.snapshot().events.at(-1), { phase: "cv", attempt: 3, kind: "transport_error", code: "ECONNRESET" });
  assert.equal(persisted.length, 2);
  assert.equal(JSON.stringify(persisted).includes("secret request text"), false);
});
