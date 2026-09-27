/**
 * Record a build's model calls, and serve them again without the provider.
 *
 * `RecordingClient` wraps any client the engine takes and writes every answered request, with its
 * response, as one line of a JSONL file. `ReplayClient` reads that file back and answers each
 * request from it: the same registry entry, at the same version, for the same stage, with exactly
 * the same input. Anything else is a miss, and a miss fails the call with a message naming the
 * prompt and its version; the provider is never called.
 *
 * The input hash covers everything that decides the answer — the model, the effort, the ceiling,
 * the system prompt, the user turn, the output schema and the tools — and leaves out only how the
 * request travels (the refusal-fallback beta and its parameter). So a replay asked for another
 * route, or given an edited prompt, misses instead of passing off the recorded answer as its own.
 *
 * Nothing secret is written: the request options (headers, signal) are never recorded, keys that
 * name a credential are dropped wherever they appear, and any secret the caller names — the API
 * key — is redacted from each line before it reaches the file.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AiBatchesLike, AiBatchLike, AiBatchMeta, AiBatchResultLike, AiCallMeta, AiClientLike, AiStreamLike, ParseResponse } from "./engine";

/** What a recording is filed under. */
export interface RecordingKey {
  promptId: string;
  promptVersion: string;
  stage: string | null;
  inputHash: string;
}

/** One answered request, as a line of the recording. */
export interface RecordedCall extends RecordingKey {
  kind: "call";
  request: Record<string, unknown>;
  response: ParseResponse;
  recordedAt: string;
}

/**
 * One submitted Message Batch: the batch the provider named and, for each request in it, the
 * registry entry and input it was filed under. Written when the batch is sent, so its results can
 * be filed under their prompts by whichever process reads them, however much later.
 */
export interface RecordedBatchSubmission {
  kind: "batch_submit";
  batchId: string;
  requests: Array<RecordingKey & { customId: string; request: Record<string, unknown> }>;
  recordedAt: string;
}

/** One batch request's result, filed under its prompt, version, stage and input like a call. */
export interface RecordedBatchResult extends RecordingKey {
  kind: "batch_result";
  batchId: string;
  customId: string;
  result: AiBatchResultLike["result"];
  recordedAt: string;
}

/** Transport-only fields: how a request travels, not what it asks. */
const TRANSPORT_FIELDS = new Set(["betas", "fallbacks", "stream"]);
const SECRET_KEY = /^(api[-_]?key|x-api-key|authorization|auth[-_]?token|anthropic[-_]api[-_]key)$/i;

/** JSON with object keys sorted, so the same request always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Drop every field that names a credential, at any depth. */
function withoutSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutSecrets) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, inner]) => [key, withoutSecrets(inner)])) as T;
  return value;
}

/** The request as recorded: what it asks, without transport fields or credentials. */
export function recordedRequest(params: Record<string, unknown>): Record<string, unknown> {
  return withoutSecrets(Object.fromEntries(Object.entries(params).filter(([key]) => !TRANSPORT_FIELDS.has(key))));
}

/** The hash of what a request asks. */
export function requestInputHash(params: Record<string, unknown>): string {
  return createHash("sha256").update(canonical(recordedRequest(params))).digest("hex");
}

export function recordingKey(params: Record<string, unknown>, meta: AiCallMeta | undefined): RecordingKey {
  if (!meta) throw new Error("A recorded call must name its registry entry; the engine always does.");
  return { promptId: meta.promptId, promptVersion: meta.promptVersion, stage: meta.stage ?? null, inputHash: requestInputHash(params) };
}

const keyString = (key: RecordingKey) => `${key.promptId}@${key.promptVersion}|${key.stage ?? ""}|${key.inputHash}`;

export interface RecordingClientOptions {
  /** The JSONL file each answered call is appended to. Its directory is created. */
  path: string;
  /** Values that must never reach the file, such as the API key; each is redacted from every line. */
  secrets?: readonly (string | undefined)[];
  now?: () => Date;
}

/**
 * A client that answers through `inner` and writes every answered call to `path`. A call that
 * failed is not recorded: a replay of it misses, and says so, rather than inventing an answer.
 */
export class RecordingClient implements AiClientLike {
  readonly messages: AiClientLike["messages"];
  readonly beta?: { messages: AiClientLike["messages"] };
  /** How many calls this client has written. */
  recorded = 0;
  private readonly secrets: string[];

  /** Each submitted batch's requests by `custom_id`, for filing its results under their prompts. */
  private readonly submitted = new Map<string, Map<string, RecordingKey>>();

  constructor(private readonly inner: AiClientLike, private readonly options: RecordingClientOptions) {
    this.secrets = (options.secrets ?? []).filter((secret): secret is string => !!secret && secret.length >= 8);
    mkdirSync(dirname(options.path), { recursive: true });
    this.messages = this.wrap(inner.messages);
    if (inner.messages.batches) this.messages.batches = this.wrapBatches(inner.messages.batches);
    if (inner.beta?.messages) this.beta = { messages: this.wrap(inner.beta.messages) };
  }

  private append(value: unknown): void {
    let line = JSON.stringify(value);
    for (const secret of this.secrets) line = line.split(secret).join("[redacted]");
    appendFileSync(this.options.path, line + "\n");
  }

  private at(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private write(params: Record<string, unknown>, meta: AiCallMeta | undefined, response: ParseResponse): void {
    const call: RecordedCall = {
      kind: "call", ...recordingKey(params, meta), request: recordedRequest(params),
      response: withoutSecrets(JSON.parse(JSON.stringify(response)) as ParseResponse),
      recordedAt: this.at(),
    };
    this.append(call);
    this.recorded++;
  }

  /** The requests of a batch this client — or an earlier process writing the same file — submitted. */
  private submission(batchId: string): Map<string, RecordingKey> | undefined {
    const known = this.submitted.get(batchId);
    if (known) return known;
    const line = readRecordingLines(this.options.path)
      .find((entry): entry is RecordedBatchSubmission & Record<string, unknown> => entry.kind === "batch_submit" && entry.batchId === batchId);
    if (!line) return undefined;
    const requests = new Map(line.requests.map(({ customId, request: _request, ...key }) => [customId, key]));
    this.submitted.set(batchId, requests);
    return requests;
  }

  /**
   * The batch resource, recorded: each submission as one line naming every request's key, and
   * each result as one line filed under the key of the request it answers. A result whose request
   * this recording never saw submitted is passed on unrecorded, since it cannot be filed.
   */
  private wrapBatches(batches: AiBatchesLike): AiBatchesLike {
    return {
      create: async (params, options, meta) => {
        const batch = await batches.create(params, options, meta);
        const requests = params.requests.map(item => ({
          customId: item.custom_id, ...recordingKey(item.params, meta?.requests[item.custom_id]), request: recordedRequest(item.params),
        }));
        const submission: RecordedBatchSubmission = { kind: "batch_submit", batchId: batch.id, requests, recordedAt: this.at() };
        this.append(submission);
        this.submitted.set(batch.id, new Map(requests.map(({ customId, request: _request, ...key }) => [customId, key])));
        return batch;
      },
      retrieve: (batchId, params, options) => batches.retrieve(batchId, params, options),
      results: async (batchId, params, options) => {
        const inner = await batches.results(batchId, params, options);
        const record = (result: AiBatchResultLike) => {
          const key = this.submission(batchId)?.get(result.custom_id);
          if (!key) return;
          const line: RecordedBatchResult = {
            kind: "batch_result", ...key, batchId, customId: result.custom_id,
            result: withoutSecrets(JSON.parse(JSON.stringify(result.result)) as AiBatchResultLike["result"]), recordedAt: this.at(),
          };
          this.append(line);
          this.recorded++;
        };
        return {
          async *[Symbol.asyncIterator]() {
            for await (const result of inner) {
              record(result);
              yield result;
            }
          },
        };
      },
    };
  }

  private wrap(messages: AiClientLike["messages"]): AiClientLike["messages"] {
    const wrapped: AiClientLike["messages"] = {
      create: async (params, options, meta) => {
        const response = await messages.create(params, options, meta);
        this.write(params, meta, response);
        return response;
      },
    };
    if (messages.stream) {
      const stream = messages.stream.bind(messages);
      wrapped.stream = (params, options, meta): AiStreamLike => {
        const open = stream(params, options, meta);
        return {
          on: (event, listener) => { open.on(event, listener); return undefined; },
          abort: () => open.abort(),
          finalMessage: () => open.finalMessage().then(response => { this.write(params, meta, response); return response; }),
          get currentMessage() { return open.currentMessage; },
          get request_id() { return open.request_id; },
        };
      };
    }
    return wrapped;
  }
}

/** A request the recording holds no answer for. */
export class ReplayMissError extends Error {
  constructor(readonly key: RecordingKey) {
    super(`No recorded answer for ${key.promptId} at version ${key.promptVersion}` +
      `${key.stage ? ` (stage ${key.stage})` : ""}: the prompt, its input or its route differs from the recording ` +
      `(input ${key.inputHash.slice(0, 12)}). The provider was not called.`);
    this.name = "ReplayMissError";
  }
}

/** Every line of a recording file, parsed; a file not written yet has none. */
function readRecordingLines(path: string): Array<{ kind?: string } & Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as { kind?: string } & Record<string, unknown>);
}

/** Every call line of a recording file; other lines (a baseline, notes, batches) are skipped. */
export function readRecording(path: string): RecordedCall[] {
  return readRecordingLines(path).filter((line): line is RecordedCall & Record<string, unknown> => line.kind === "call");
}

/** Every batch result line of a recording file. */
export function readBatchRecording(path: string): RecordedBatchResult[] {
  return readRecordingLines(path).filter((line): line is RecordedBatchResult & Record<string, unknown> => line.kind === "batch_result");
}

/**
 * A client that answers only from a recording. The same request made twice is answered by its
 * recordings in order, and by the last one once they run out, as a build that retried would be.
 */
export class ReplayClient implements AiClientLike {
  readonly messages: AiClientLike["messages"];
  readonly beta: { messages: AiClientLike["messages"] };
  /** Every request that missed, in order. */
  readonly misses: RecordingKey[] = [];
  /** How many requests were answered. */
  hits = 0;
  private readonly served = new Map<string, number>();
  private readonly byKey = new Map<string, ParseResponse[]>();
  private readonly batchByKey = new Map<string, Array<AiBatchResultLike["result"]>>();
  private readonly batchServed = new Map<string, number>();
  /** The batches this client has been sent, each already ended with its recorded results. */
  private readonly batches = new Map<string, { batch: AiBatchLike; results: AiBatchResultLike[] }>();

  constructor(recording: ReadonlyArray<RecordedCall | RecordedBatchResult> | string) {
    const lines = typeof recording === "string" ? [...readRecording(recording), ...readBatchRecording(recording)] : recording;
    for (const line of lines) {
      const key = keyString(line);
      if (line.kind === "batch_result") this.batchByKey.set(key, [...(this.batchByKey.get(key) ?? []), line.result]);
      else this.byKey.set(key, [...(this.byKey.get(key) ?? []), line.response]);
    }
    const create = async (params: Record<string, unknown>, _options?: Record<string, unknown>, meta?: AiCallMeta) => this.answer(params, meta);
    this.messages = { create, batches: this.replayBatches() };
    this.beta = { messages: { create } };
  }

  /**
   * The batch resource, from the recording: a batch sent here has ended at once, each request
   * answered by the result recorded for the same prompt, version, stage and input — under the
   * replay's own `custom_id`, since the ids a request is named by differ from run to run. A request
   * the recording holds no result for is a miss, and comes back errored, naming the miss; the
   * provider is never called.
   */
  private replayBatches(): AiBatchesLike {
    const held = (batchId: string) => {
      const batch = this.batches.get(batchId);
      if (!batch) throw new Error(`No replayed batch ${batchId}: it was not sent to this client.`);
      return batch;
    };
    return {
      create: async (params, _options, meta?: AiBatchMeta) => {
        const id = `replay_batch_${this.batches.size + 1}`;
        const results: AiBatchResultLike[] = params.requests.map((item): AiBatchResultLike => {
          const key = recordingKey(item.params, meta?.requests[item.custom_id]);
          const name = keyString(key);
          const recorded = this.batchByKey.get(name);
          if (!recorded?.length) {
            this.misses.push(key);
            return { custom_id: item.custom_id, result: { type: "errored", error: { type: "error", error: { type: "replay_miss", message: new ReplayMissError(key).message } } } };
          }
          const index = this.batchServed.get(name) ?? 0;
          this.batchServed.set(name, index + 1);
          this.hits++;
          return { custom_id: item.custom_id, result: structuredClone(recorded[Math.min(index, recorded.length - 1)]!) };
        });
        const count = (type: string) => results.filter(result => result.result.type === type).length;
        const batch: AiBatchLike = {
          id, processing_status: "ended",
          request_counts: { processing: 0, succeeded: count("succeeded"), errored: count("errored"), canceled: count("canceled"), expired: count("expired") },
        };
        this.batches.set(id, { batch, results });
        return structuredClone(batch);
      },
      retrieve: async batchId => structuredClone(held(batchId).batch),
      results: async batchId => {
        const results = structuredClone(held(batchId).results);
        return { async *[Symbol.asyncIterator]() { yield* results; } };
      },
    };
  }

  /** How many distinct requests the recording can answer, live or batched. */
  get size(): number {
    return this.byKey.size + this.batchByKey.size;
  }

  private answer(params: Record<string, unknown>, meta: AiCallMeta | undefined): ParseResponse {
    const key = recordingKey(params, meta);
    const id = keyString(key);
    const responses = this.byKey.get(id);
    if (!responses?.length) {
      this.misses.push(key);
      throw new ReplayMissError(key);
    }
    const index = this.served.get(id) ?? 0;
    this.served.set(id, index + 1);
    this.hits++;
    return structuredClone(responses[Math.min(index, responses.length - 1)]!);
  }
}
