import { describe, expect, it } from "vitest";
import { createAiEngine, mergeCvAssessBatches, type AiClientLike, type AiUsageRecord, type CvAssessBatchEvent, type ParseResponse } from "./engine";

const inputFor = (requirements: number, claims: number) => ({
  rubric: { requirements: Array.from({ length: requirements }, (_, i) => ({ id: `r${i}`, label: "Operations", quote: "Lead operations", importance: "essential" as const, category: "experience" as const })), caveats: [] },
  cv: [{ id: "profile", text: "Operations leader" }],
  claims: Array.from({ length: claims }, (_, i) => ({ id: `claim${i}`, text: "Operations leader" })),
  evidence: [{ id: "source:profile", text: "Operations leader" }],
});
const payloadOf = (params: Record<string, unknown>) =>
  Object.assign({}, ...(params.messages as Array<{ content: Array<{ text: string }> }>)[0]!.content.map(block => JSON.parse(block.text)));
const answerFor = (batch: { requirements: Array<{ id: string }>; claims: Array<{ id: string }> }) => ({
  matches: batch.requirements.map(item => ({ requirementId: item.id, status: "demonstrated", libraryStatus: "demonstrated", cvEvidence: [{ id: "profile", quote: "Operations leader" }], libraryEvidence: [{ id: "source:profile", quote: "Operations leader" }], reason: "Supported", improvement: "" })),
  claims: batch.claims.map(item => ({ claimId: item.id, status: "supported", evidence: [{ id: "source:profile", quote: "Operations leader" }], reason: "Supported" })),
});

/** A streaming client whose responses begin on the next tick and end when `respond` settles. */
function streaming(respond: (params: Record<string, unknown>, index: number, signal?: AbortSignal) => Promise<ParseResponse>) {
  const calls: Array<Record<string, unknown>> = [];
  const client: AiClientLike = { messages: {
    create: () => Promise.reject(new Error("streams only")),
    stream(params, options) {
      const index = calls.length;
      calls.push(params);
      const signal = options?.signal as AbortSignal | undefined;
      const listeners: Array<() => void> = [];
      let cut = () => {};
      const stream = {
        currentMessage: undefined as ParseResponse | undefined,
        on(_event: "streamEvent", listener: () => void) { listeners.push(listener); return stream; },
        abort() { cut(); },
        finalMessage: () => new Promise<ParseResponse>((resolve, reject) => {
          let done = false;
          cut = () => { if (!done) reject(new Error("Request was aborted.")); };
          signal?.addEventListener("abort", () => cut());
          Promise.resolve().then(() => {
            stream.currentMessage = { usage: { input_tokens: 400 } };
            for (const listener of listeners) listener();
            return respond(params, index, signal);
          }).then(response => { done = true; resolve(response); }, error => { done = true; reject(error); });
        }),
      };
      return stream;
    },
  } };
  return { client, calls };
}
const hang = (signal?: AbortSignal) => new Promise<ParseResponse>((_, reject) => signal!.addEventListener("abort", () => reject(new Error("Request was aborted."))));

describe("an audit's batches, each as it ended", () => {
  it("keeps the batches that finished when one fails, and reports the siblings it stopped as cancelled", async () => {
    const input = inputFor(40, 40);
    const { client } = streaming((params, index, signal) => {
      if (index === 0) return Promise.resolve({ parsed_output: answerFor(payloadOf(params)), usage: { input_tokens: 10, output_tokens: 10 } });
      if (index === 1) return Promise.reject(new Error("Request timed out."));
      return hang(signal);
    });
    const events: CvAssessBatchEvent[] = [];
    const engine = createAiEngine({ client, getModel: () => "claude-fable-5-1" });
    const audit = await engine.assessCvBatches(input, { refType: "cv-review", refId: "draft" }, { onBatch: event => { events.push(event); } });
    expect(audit.total).toBe(5);
    expect(audit.review).toBeNull();
    expect(audit.batches.map(batch => batch.status)).toEqual(["done", "failed", "cancelled", "cancelled", "cancelled"]);
    expect(audit.batches[0]!.result!.matches).toHaveLength(8);
    expect(audit.batches[0]!.usage).toHaveLength(1);
    expect(audit.batches[1]).toMatchObject({ error: "Request timed out.", failure: { kind: "unknown" } });
    // A sibling stopped because another failed carries no error text of its own.
    for (const batch of audit.batches.slice(2)) {
      expect(batch.error).toBeUndefined();
      expect(batch.failure).toBeUndefined();
      expect(batch.usage).toHaveLength(1);
    }
    expect(events.filter(event => event.phase === "cancelled").map(event => event.index).sort()).toEqual([2, 3, 4]);
    expect(events.every(event => event.pass === "draft")).toBe(true);
  });

  it("re-runs only the batches it is asked for, which merge with the checkpointed ones into the whole audit", async () => {
    const input = inputFor(40, 40);
    const answered = (params: Record<string, unknown>) => Promise.resolve({ parsed_output: answerFor(payloadOf(params)), usage: { input_tokens: 10, output_tokens: 10 } });
    const full = await createAiEngine({ client: streaming(answered).client, getModel: () => "claude-fable-5-1" }).assessCvBatches(input);
    const { client, calls } = streaming(answered);
    const rerun = await createAiEngine({ client, getModel: () => "claude-fable-5-1" }).assessCvBatches(input, {}, { only: [3, 1] });
    expect(calls).toHaveLength(2);
    expect(rerun.batches.map(batch => [batch.index, batch.status])).toEqual([[1, "done"], [3, "done"]]);
    // Only part of the audit ran, so there is no whole review to return from this run alone.
    expect(rerun.review).toBeNull();
    const checkpointed = full.batches.filter(batch => ![1, 3].includes(batch.index));
    const merged = mergeCvAssessBatches([...checkpointed, ...rerun.batches].sort((a, b) => a.index - b.index).map(batch => batch.result!));
    expect(merged).toEqual(full.review);
  });

  it("sends nothing more when the first batch fails before its response begins", async () => {
    const input = inputFor(24, 1);
    const calls: Array<Record<string, unknown>> = [];
    const engine = createAiEngine({ getModel: () => "claude-fable-5-1", client: { messages: { create: async params => {
      calls.push(params);
      throw new Error("socket hang up");
    } } } });
    const audit = await engine.assessCvBatches(input);
    expect(calls).toHaveLength(1);
    expect(audit.batches.map(batch => [batch.status, batch.usage.length])).toEqual([["failed", 1], ["cancelled", 0], ["cancelled", 0]]);
  });

  it("records the audit of a revised candidate as its own stage, and says which audit each batch belongs to", async () => {
    const base = inputFor(2, 2);
    const input = { ...base, claims: base.claims.map(claim => ({ ...claim, requiredEvidenceId: "entry:role" })),
      evidence: [...base.evidence, { id: "entry:role", text: "Operations leader" }] };
    const usage: AiUsageRecord[] = [];
    const events: CvAssessBatchEvent[] = [];
    let n = 0;
    const engine = createAiEngine({ getModel: () => "claude-fable-5-1", onUsage: record => { usage.push(record); }, client: { messages: { create: async params => {
      const answer = answerFor(payloadOf(params));
      // The first answer cites the wrong source, so the batch is re-run once to correct it.
      if (n++ > 0) for (const claim of answer.claims) claim.evidence = [{ id: "entry:role", quote: "Operations leader" }];
      return { parsed_output: answer, usage: { input_tokens: 10, output_tokens: 10 } };
    } } } });
    const audit = await engine.assessCvBatches(input, { refType: "cv-review", refId: "draft", stage: "review" }, { pass: "revision", onBatch: event => { events.push(event); } });
    expect(audit.pass).toBe("revision");
    expect(audit.review).not.toBeNull();
    expect(usage.map(record => [record.stage, record.promptId])).toEqual([["review_candidate", "cv.review_candidate"], ["review_candidate_retry", "cv.review_candidate"]]);
    expect(events.every(event => event.pass === "revision")).toBe(true);
    expect(audit.batches[0]!.usage).toHaveLength(2);
  });
});
