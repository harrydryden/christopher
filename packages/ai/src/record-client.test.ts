import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAiEngine, type AiClientLike, type AiUsageRecord, type ParseResponse } from "./engine";
import { RecordingClient, ReplayClient, ReplayMissError, readRecording, requestInputHash } from "./record-client";

const rubric = { requirements: [{ id: "r1", label: "Lead a team", quote: "Lead a team", importance: "essential", category: "experience" }], caveats: [] };
const SECRET = "sk-ant-test-0123456789abcdef";

/** A provider stand-in that streams one answer per call and counts what it was asked. */
function provider() {
  const calls: Array<Record<string, unknown>> = [];
  const answer = (params: Record<string, unknown>): ParseResponse => {
    calls.push(params);
    return { parsed_output: rubric, usage: { input_tokens: 1200, output_tokens: 300 }, stop_reason: "end_turn", model: params.model as string };
  };
  const client: AiClientLike = {
    messages: {
      create: async params => answer(params),
      stream(params) {
        let response: ParseResponse | undefined;
        const listeners: Array<() => void> = [];
        return {
          on(_event, listener) { listeners.push(listener); return undefined; },
          abort() {},
          get currentMessage() { return response; },
          request_id: "req_1",
          finalMessage: async () => {
            for (const listener of listeners) listener();
            response = answer(params);
            // The SDK's response carries the credential nowhere, but a recording must not trust that.
            return { ...response, headers: { "x-api-key": SECRET } } as ParseResponse;
          },
        };
      },
    },
  };
  return { client, calls };
}

const scratch = () => join(mkdtempSync(join(tmpdir(), "ava-recording-")), "calls.jsonl");

describe("recording and replaying model calls", () => {
  it("records each answered call under its prompt, version, stage and input, and replays it without the provider", async () => {
    const path = scratch();
    const live = provider();
    const recorder = new RecordingClient(live.client, { path, secrets: [SECRET] });
    const usage: AiUsageRecord[] = [];
    const recorded = await createAiEngine({ client: recorder, getModel: () => "claude-fable-5-1", onUsage: record => { usage.push(record); } })
      .analyseCvJob("Lead a team", { stage: "rubric" });
    expect(recorded).toEqual(rubric);
    expect(recorder.recorded).toBe(1);

    const [call] = readRecording(path);
    expect(call).toMatchObject({ kind: "call", promptId: "cv.rubric", promptVersion: usage[0]!.promptVersion, stage: "rubric" });
    expect(call!.inputHash).toBe(requestInputHash(live.calls[0]!));
    // The recording names no credential anywhere: not the header, not the key's value.
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/x-api-key/i);

    const replay = new ReplayClient(path);
    const replayUsage: AiUsageRecord[] = [];
    const replayed = await createAiEngine({ client: replay, getModel: () => "claude-fable-5-1", onUsage: record => { replayUsage.push(record); } })
      .analyseCvJob("Lead a team", { stage: "rubric" });
    expect(replayed).toEqual(rubric);
    expect(replay.hits).toBe(1);
    expect(live.calls).toHaveLength(1);
    // The recorded usage is served again, so a replay reports what the recorded run cost.
    expect(replayUsage[0]!.costUsd).toBe(usage[0]!.costUsd);
  });

  it("misses, naming the prompt and its version, when the input or the route differs, and never calls the provider", async () => {
    const path = scratch();
    await createAiEngine({ client: new RecordingClient(provider().client, { path }), getModel: () => "claude-fable-5-1" })
      .analyseCvJob("Lead a team", { stage: "rubric" });
    const version = readRecording(path)[0]!.promptVersion;

    const otherInput = new ReplayClient(path);
    const failures: AiUsageRecord[] = [];
    const engine = createAiEngine({ client: otherInput, getModel: () => "claude-fable-5-1", onUsage: record => { failures.push(record); } });
    expect(await engine.analyseCvJob("Lead two teams", { stage: "rubric" })).toBeNull();
    expect(otherInput.misses).toHaveLength(1);
    expect(failures[0]!.error).toContain(`cv.rubric at version ${version}`);

    // The same input at another effort is another request: the recorded answer is not passed off as its answer.
    const otherRoute = new ReplayClient(path);
    const routed = createAiEngine({ client: otherRoute, getModel: () => "claude-fable-5-1", getStageRoutes: () => ({ "cv.rubric": { effort: "medium" } }) });
    expect(await routed.analyseCvJob("Lead a team", { stage: "rubric" })).toBeNull();
    expect(otherRoute.misses[0]).toMatchObject({ promptId: "cv.rubric", promptVersion: version });
    expect(() => { throw new ReplayMissError(otherRoute.misses[0]!); }).toThrow(/The provider was not called/);
  });

  it("reads only the call lines of a recording, and answers a repeated request in recorded order", async () => {
    const path = scratch();
    const call = (text: string) => ({ kind: "call", promptId: "cv.rubric", promptVersion: "v1", stage: null, inputHash: "h",
      request: {}, response: { content: [{ type: "text", text }] }, recordedAt: "2026-09-26T00:00:00.000Z" });
    writeFileSync(path, [JSON.stringify({ kind: "baseline", score: 80 }), JSON.stringify(call("first")), JSON.stringify(call("second"))].join("\n") + "\n");
    const replay = new ReplayClient(readRecording(path).map(line => ({ ...line, inputHash: requestInputHash({ a: 1 }) })));
    const meta = { promptId: "cv.rubric", promptVersion: "v1" };
    const texts = [];
    for (let i = 0; i < 3; i++) texts.push((await replay.messages.create({ a: 1 }, {}, meta)).content![0]!.text);
    expect(texts).toEqual(["first", "second", "second"]);
    // Transport fields do not change what a request asks.
    expect(requestInputHash({ a: 1, betas: ["x"], fallbacks: "default" })).toBe(requestInputHash({ a: 1 }));
  });
});
