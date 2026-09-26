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
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AiCallMeta, AiClientLike, AiStreamLike, ParseResponse } from "./engine";

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

  constructor(private readonly inner: AiClientLike, private readonly options: RecordingClientOptions) {
    this.secrets = (options.secrets ?? []).filter((secret): secret is string => !!secret && secret.length >= 8);
    mkdirSync(dirname(options.path), { recursive: true });
    this.messages = this.wrap(inner.messages);
    if (inner.beta?.messages) this.beta = { messages: this.wrap(inner.beta.messages) };
  }

  private write(params: Record<string, unknown>, meta: AiCallMeta | undefined, response: ParseResponse): void {
    const call: RecordedCall = {
      kind: "call", ...recordingKey(params, meta), request: recordedRequest(params),
      response: withoutSecrets(JSON.parse(JSON.stringify(response)) as ParseResponse),
      recordedAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
    let line = JSON.stringify(call);
    for (const secret of this.secrets) line = line.split(secret).join("[redacted]");
    appendFileSync(this.options.path, line + "\n");
    this.recorded++;
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

/** Every call line of a recording file; other lines (a baseline, notes) are skipped. */
export function readRecording(path: string): RecordedCall[] {
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)
    .map(line => JSON.parse(line) as { kind?: string })
    .filter((line): line is RecordedCall => line.kind === "call");
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

  constructor(recording: readonly RecordedCall[] | string) {
    const calls = typeof recording === "string" ? readRecording(recording) : recording;
    for (const call of calls) {
      const key = keyString(call);
      this.byKey.set(key, [...(this.byKey.get(key) ?? []), call.response]);
    }
    const create = async (params: Record<string, unknown>, _options?: Record<string, unknown>, meta?: AiCallMeta) => this.answer(params, meta);
    this.messages = { create };
    this.beta = { messages: { create } };
  }

  /** How many distinct requests the recording can answer. */
  get size(): number {
    return this.byKey.size;
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
