/** A one-process, fail-closed transport ceiling for an explicitly authorised live evaluation. */
export function requestUpperBoundUsd(body, expectedModel) {
  if (typeof body !== "string") throw new Error("Evaluation request body must be JSON text.");
  let request;
  try { request = JSON.parse(body); }
  catch { throw new Error("Evaluation request body is not valid JSON."); }
  if (request.model !== expectedModel || request.tools !== undefined)
    throw new Error("Evaluation request changed model or enabled tools.");
  const allowed = new Set(["model", "max_tokens", "messages", "system", "temperature", "top_p", "top_k",
    "stop_sequences", "stream", "metadata", "output_config", "thinking", "service_tier"]);
  if (Object.keys(request).some(key => !allowed.has(key)))
    throw new Error("Evaluation request contains an unreviewed feature.");
  if (request.service_tier && request.service_tier !== "standard_only")
    throw new Error("Evaluation request selected an unpriced service tier.");
  const textOnly = content => typeof content === "string"
    || (Array.isArray(content) && content.every(block => block && typeof block === "object"
      && block.type === "text" && typeof block.text === "string"
      && Object.keys(block).every(key => ["type", "text", "cache_control", "citations"].includes(key))));
  if (!Array.isArray(request.messages) || !request.messages.every(message => message && typeof message === "object"
    && ["user", "assistant"].includes(message.role) && textOnly(message.content)
    && Object.keys(message).every(key => ["role", "content"].includes(key)))
    || (request.system !== undefined && !textOnly(request.system)))
    throw new Error("Evaluation permits text-only messages and system prompts.");
  const maxTokens = request.max_tokens;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32_000)
    throw new Error("Evaluation request has an unexpected output ceiling.");
  // Fable 5.1: $20/MTok is the dearest input/cache-write tier and $50/MTok is output.
  // One token cannot occupy less than one UTF-8 byte; double the input bound again for safety.
  return (Buffer.byteLength(body, "utf8") * 40 + maxTokens * 50) / 1_000_000;
}

export function installLiveEvaluationGuard({ model, maxUsd, phases, prior, onDebit, forward = globalThis.fetch }) {
  if (model !== "claude-fable-5-1" || maxUsd !== 10 || typeof forward !== "function")
    throw new Error("Live evaluation guard requires the reviewed model and $10 ceiling.");
  let phase = null;
  let totalBound = prior?.totalUpperBoundUsd ?? 0;
  const phaseBound = Object.fromEntries(Object.keys(phases).map(name => [name, prior?.upperBoundsUsd?.[name] ?? 0]));
  const counts = Object.fromEntries(Object.keys(phases).map(name => [name, prior?.attempts?.[name] ?? 0]));
  if (!Number.isFinite(totalBound) || totalBound < 0 || totalBound > maxUsd
    || Object.values(phaseBound).some(value => !Number.isFinite(value) || value < 0)
    || Object.values(counts).some(value => !Number.isInteger(value) || value < 0)
    || Object.values(phaseBound).reduce((sum, value) => sum + value, 0) > totalBound + 0.000001)
    throw new Error("Invalid prior evaluation spend ledger.");
  const events = [...(prior?.events ?? [])];
  const snapshot = () => ({ totalUpperBoundUsd: totalBound, upperBoundsUsd: { ...phaseBound }, attempts: { ...counts }, events: [...events] });
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.protocol !== "https:" || url.hostname !== "api.anthropic.com" || url.port
      || url.pathname !== "/v1/messages" || url.search || (init?.method ?? "GET").toUpperCase() !== "POST")
      throw new Error("Live evaluation blocked an unexpected outbound request.");
    if (!phase || !Object.hasOwn(phases, phase)) throw new Error("Live evaluation phase is unset.");
    const body = init?.body;
    const headers = new Headers(init?.headers);
    if ([...headers.entries()].some(([name, value]) => /fallback/u.test(name) || /fallback/u.test(value)))
      throw new Error("Evaluation disallows server-side model fallback.");
    const bound = requestUpperBoundUsd(body, model);
    const blocked = counts[phase] >= phases[phase].maxRequests ? "request_count"
      : phaseBound[phase] + bound > phases[phase].maxUsd ? "phase_spend"
      : totalBound + bound > maxUsd ? "total_spend" : null;
    if (blocked) {
      events.push({ phase, kind: "blocked_before_transport", reason: blocked, upperBoundUsd: Number(bound.toFixed(6)) });
      onDebit?.(snapshot());
      throw new Error("Live evaluation spend ceiling reached before another request.");
    }
    // Debit before transport, including a request that fails or is retried by the SDK.
    counts[phase]++;
    phaseBound[phase] += bound;
    totalBound += bound;
    onDebit?.(snapshot());
    try {
      const response = await forward(input, { ...init, redirect: "error" });
      const diagnostic = await responseDiagnostic(response);
      events.push({ phase, attempt: counts[phase], kind: "response", status: response.status,
        upperBoundUsd: Number(bound.toFixed(6)), ...diagnostic });
      if (response.ok && diagnostic.complete && diagnostic.usage) {
        const actual = usageCostUsd(diagnostic.usage);
        if (actual !== null && actual <= bound) {
          phaseBound[phase] -= bound - actual;
          totalBound -= bound - actual;
          events.push({ phase, attempt: counts[phase], kind: "settled", costUsd: Number(actual.toFixed(6)) });
        }
      }
      return response;
    } catch (error) {
      const value = error?.cause?.code ?? error?.code ?? error?.name;
      const code = typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : "UNKNOWN";
      events.push({ phase, attempt: counts[phase], kind: "transport_error", code });
      throw error;
    } finally { onDebit?.(snapshot()); }
  };
  return {
    setPhase(value) {
      if (!Object.hasOwn(phases, value)) throw new Error("Unknown evaluation phase.");
      phase = value;
    },
    snapshot,
    restore() { globalThis.fetch = previous; },
  };
}

function safeTokenCount(value) { return Number.isInteger(value) && value >= 0 ? value : null; }
function usageCostUsd(usage) {
  const input = safeTokenCount(usage.input_tokens);
  const output = safeTokenCount(usage.output_tokens);
  const read = safeTokenCount(usage.cache_read_input_tokens ?? 0);
  const write = safeTokenCount(usage.cache_creation_input_tokens ?? 0);
  const oneHour = safeTokenCount(usage.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  if ([input, output, read, write, oneHour].some(value => value === null) || oneHour > write) return null;
  return Number(((input * 10 + output * 50 + read * 0.25 + (write - oneHour) * 12.5 + oneHour * 20) / 1_000_000).toFixed(6));
}

async function responseDiagnostic(response) {
  let body;
  try { body = await response.clone().text(); } catch { return { complete: false, diagnostic: "unreadable" }; }
  const type = response.headers.get("content-type") ?? "";
  let complete = false;
  let usage;
  let stopReason;
  let errorType;
  const visit = (event, data) => {
    if (!data || typeof data !== "object") return;
    if (event === "message_start") usage = data.message?.usage;
    if (event === "message_delta") { usage = { ...(usage ?? {}), ...(data.usage ?? {}) }; stopReason = data.delta?.stop_reason; }
    if (event === "message_stop") complete = true;
    if (event === "error" || data.type === "error") errorType = data.error?.type;
  };
  if (type.includes("text/event-stream")) {
    for (const block of body.split(/\r?\n\r?\n/u)) {
      const event = block.match(/^event:\s*(\S+)/mu)?.[1];
      const data = block.match(/^data:\s*(.+)$/mu)?.[1];
      if (!event || !data) continue;
      try { visit(event, JSON.parse(data)); } catch { /* Never include provider data in diagnostics. */ }
    }
  } else {
    try { const data = JSON.parse(body); usage = data.usage; stopReason = data.stop_reason; complete = data.type === "message" && !!usage; errorType = data.error?.type; }
    catch { /* The body is never logged. */ }
  }
  return { complete, ...(usage && typeof usage === "object" ? { usage: {
    input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_creation: usage.cache_creation,
  } } : {}), ...(typeof stopReason === "string" && /^[a-z_]{1,32}$/u.test(stopReason) ? { stopReason } : {}),
  ...(typeof errorType === "string" && /^[a-z_]{1,40}$/u.test(errorType) ? { errorType } : {}) };
}
