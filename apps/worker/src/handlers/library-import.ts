/**
 * One document on its way into somebody's Library.
 *
 * The shape of it: turn what they gave us into text, read it once with a model, keep only what
 * the text supports, and write that back as a proposal for them to tick through. Nothing reaches
 * the Library from here — `acceptLibraryImport` in the interface does that, after the person has
 * said which items are theirs.
 *
 * Four things are deliberate.
 *
 * The conversion happens before the budget is asked about, so an account with nothing left to
 * spend still gets its document turned into text and stored: the bytes are cleared either way,
 * and the person can raise their budget and try the same import again rather than re-uploading.
 *
 * A refusal finishes the task rather than failing it, exactly as the evidence review does. A
 * document that is a photograph, a URL that refuses the fetcher, a month that is spent: none of
 * them is fixed by the queue trying again, and all of them would fill Health with work nothing
 * can complete. What the person can act on is written on the row as a sentence and shown to them.
 *
 * Only transport failures throw. A site having a bad minute is worth the queue's backoff. The
 * model having one is said as what it is — busy, cut short, unavailable — with the document kept,
 * so the card's Try again reads it once more; only an answer that was no proposal at all is the
 * document's fault.
 *
 * And the post-check is not optional. `validateLibraryProposal` drops every employer, title, row,
 * qualification and skill the document does not carry, and counts them, before anything is
 * stored — so what the person reviews is a proposal about their own document rather than about a
 * career a model found plausible.
 */
import {
  aiBudgetRefusalMessage,
  aiBudgetWindowStart,
  aiFeatureLabel,
  countProposedItems,
  libraryImportUrl,
  stripHtml,
  usd,
  validateLibraryProposal,
  type TaskPayloads,
} from "@ava/core";
import { createAiEngine, estimateLibraryImportUsd, type AiFailure } from "@ava/ai";
import {
  completeLibraryImport,
  enqueueTask,
  getLibraryImportForWorker,
  type Db,
  type Task,
} from "@ava/db";
import { recordAiUsage, tryReserveAi, type AiHold } from "../budget";
import { makeFetchContext, type WorkerDeps } from "../context";
import { capDocumentText, DocumentReadError, documentToText, tidyDocumentText } from "../document-text";
import { HostBusyError, PrivateAddressError } from "../fetcher";
import type { TaskRunContext } from "../queue";
import { log } from "../log";

/** Less than this is not a document: the model would be reading a sentence for a career. */
const SHORTEST_DOCUMENT = 40;

/** How long the extraction may hold its share of the month: the task's deadline, with room to spare. */
const HOLD_MINUTES = 10;

/** A page that answers with less text than this is a shell waiting for its JavaScript. */
const JS_SHELL_TEXT = 400;

/** How many times one import waits for its host's turn before the queue's own retries take over. */
const MAX_HOST_WAITS = 10;

/**
 * What the person is told when the call returned nothing, by why it did. A provider that was
 * rate-limited, overloaded or dropped the connection, an answer cut off at its length limit, a
 * model the deployment cannot reach: none of those is anything wrong with the document, and
 * "AVA could not read that document" sent people off to re-export a file that was fine.
 */
function unansweredMessage(failure: AiFailure | undefined): string {
  switch (failure?.kind) {
    case "rate_limited":
    case "overloaded":
    case "connection":
    case "stalled":
    case "unknown":
      return "AVA's model provider was too busy to read that document just now. Your document is kept: try this import again in a few minutes.";
    case "output_limit":
      return "Reading that document ran past the longest answer the model may give, so nothing was proposed. Your document is kept: try this import again, or paste the part of it that covers your career.";
    case "model_access":
      return "AVA cannot reach its model at the moment, so the document was not read. Your document is kept: try this import again later.";
    default:
      return "AVA could not read that document. Try a different export of it, or paste the text instead.";
  }
}

export async function handleImportLibraryDocument(task: Task, deps: WorkerDeps, ctx?: TaskRunContext): Promise<unknown> {
  const { userId, importId, hostWaits = 0 } = (task.payload ?? {}) as TaskPayloads["import_library_document"] & { hostWaits?: number };
  if (!userId || !importId) return { skipped: "no import on task" };
  const row = await getLibraryImportForWorker(deps.db, importId);
  // Deleted while the task waited, or pointed at somebody else's row: neither is this task's to do.
  if (!row) return { skipped: "import no longer exists" };
  if (row.userId !== userId) return { skipped: "import belongs to another account" };
  // A retry of a task that already finished — a completion whose lease was lost, a deadline that
  // fired after the commit — must not pay for the call again or replace a proposal the person may
  // be ticking through. Reading again is always asked for by reopening the row, which clears both.
  if (row.resolvedAt) return { skipped: "import already resolved" };
  if (row.processedAt) return { skipped: "import already read" };

  // The fetch and model call happen outside a transaction, so the queue lease can be reclaimed
  // while they are in flight. Fence every terminal write inside its own transaction: an expired
  // attempt must not overwrite its replacement's proposal or clear the upload the replacement
  // still needs to read.
  const complete = (outcome: Parameters<typeof completeLibraryImport>[2]) =>
    deps.db.transaction(async tx => {
      await deps.assertOwnership?.(tx as unknown as Db);
      return completeLibraryImport(tx as unknown as Db, importId, outcome, deps.now());
    });

  /** Record a sentence the person can act on, and finish. The bytes go with it either way. */
  const refuse = async (message: string, content?: string | null) => {
    await complete({ error: message, ...(content === undefined ? {} : { content }) });
    log.info("library import refused", { userId, importId, kind: row.kind, message });
    return { imported: false, message };
  };

  // ---- The document as text ------------------------------------------------------------------
  let text = row.content ?? "";
  let truncated = false;
  if (row.sourceBytes) {
    try {
      const converted = await documentToText(row.sourceBytes, row.sourceMime);
      text = converted.text;
      truncated = converted.truncated;
    } catch (error) {
      if (error instanceof DocumentReadError) return refuse(error.message, null);
      throw error;
    }
  } else if (!text && row.kind === "website" && row.url) {
    const fetched = await websiteText(row.url, deps);
    if ("busy" in fetched && hostWaits < MAX_HOST_WAITS) {
      // The host is paced, or asked us to come back later, and nothing was sent. The import waits
      // for its turn in the queue rather than here, so a slot is not held idle, and it is not
      // failed: this task finishes and a copy of it runs at the moment the host is free.
      const retryAt = fetched.busy.retryAt;
      await enqueueTask(deps.db, "import_library_document", { userId, importId, hostWaits: hostWaits + 1 }, {
        dedupeKey: `import_library_document:${importId}:host-wait:${hostWaits + 1}`,
        priority: task.priority ?? 1,
        runAfter: retryAt,
      });
      log.info("library import waits for its host", { userId, importId, host: fetched.busy.host, retryAt: retryAt.toISOString() });
      return { deferred: retryAt.toISOString() };
    }
    if ("busy" in fetched) throw fetched.busy;
    if ("error" in fetched) return refuse(fetched.error, null);
    if (fetched.retry) throw new Error(fetched.retry);
    text = fetched.text;
    truncated = fetched.truncated;
  }
  if (text.trim().length < SHORTEST_DOCUMENT) {
    return refuse("There was not enough text in that to read a career from. Paste more of it, or upload the document itself.", text || null);
  }

  // ---- What the month can pay for ------------------------------------------------------------
  const settings = await deps.userSettings(userId);
  // The model the account chose for its own CV work: reading a CV is the same document, read once.
  const model = settings.cvModel;
  let cost = 0;
  /** Why the call produced nothing, as the engine classified it; the engine returns null either way. */
  let failure: AiFailure | undefined;
  /** The hold this call is admitted against, once it is; its record reduces the hold in the same transaction. */
  let hold: AiHold | undefined;
  const ai = createAiEngine({
    apiKey: deps.env.anthropicApiKey,
    client: deps.aiClient,
    getModel: () => model,
    // A deadline or a reclaimed task cuts the call off rather than paying for an answer nobody reads.
    ...(ctx?.signal ? { signal: ctx.signal } : {}),
    onUsage: async ({ failure: failed, ...usage }) => {
      cost += usage.costUsd;
      failure = failed;
      await recordAiUsage(deps.db, userId, usage, { hold });
    },
    logger: (msg, data) => log.debug(`ai ${msg}`, data),
  });
  if (!ai.enabled) {
    return refuse("AVA cannot read documents at the moment: no model is configured. Your document is kept — try this import again once one is.", text);
  }
  const expected = estimateLibraryImportUsd(model, { documentBytes: Buffer.byteLength(text) });
  const admitted = await tryReserveAi(deps.db, "A11", expected, {
    account: {
      userId,
      budgetUsd: settings.aiBudgetUsd,
      since: aiBudgetWindowStart(deps.now(), settings.aiBudgetResetAt),
    },
    daily: deps.env.dailyAiBudgetUsd ?? 1000000,
    discovery: deps.env.discoveryAiBudgetUsd ?? 1000000,
    workerId: deps.env.workerId,
    refId: `library_import:${importId}`,
  }, deps.now(), HOLD_MINUTES);
  if ("refused" in admitted) {
    // Finished, never failed, and the text is kept: raising the budget and asking again reads the
    // document that is already here rather than another upload of it.
    const message = aiBudgetRefusalMessage(aiFeatureLabel("A11"), expected, admitted.refused);
    log.info("library import refused by budget", { userId, importId, expected });
    await complete({ error: message, content: text });
    return { skipped: "budget", message, cost: 0 };
  }
  hold = admitted;

  // ---- One call, then the post-check ----------------------------------------------------------
  try {
    const plan = await ai.extractLibrary({ document: text, model },
      { userId, refType: "library_import", refId: importId });
    if (!plan) {
      // A task that was given up on writes nothing: whatever replaces it reads the document.
      if (ctx?.signal.aborted) throw new Error("The import was stopped before the model answered.");
      return refuse(unansweredMessage(failure), text);
    }
    let validated: ReturnType<typeof validateLibraryProposal>;
    try {
      validated = validateLibraryProposal(text, plan);
    } catch (error) {
      // The model answered something that is not a proposal at all. That is this document's
      // answer, not a fault the queue can retry away.
      if (error instanceof Error && error.name === "ZodError") {
        return refuse("AVA could not make sense of that document. Try a different export of it, or paste the text instead.", text);
      }
      throw error;
    }
    const { proposal, dropped } = validated;
    const counts = countProposedItems(proposal);
    if (!counts.jobs && !counts.education && !counts.skills) {
      return refuse("Nothing in that document could be matched to what it says. Check that it is the right file, or paste the text instead.", text);
    }
    await complete({ proposal, content: text });
    log.info("library import read", { userId, importId, kind: row.kind, ...counts, dropped, truncated, usd: usd(cost) });
    return { proposed: counts, dropped, truncated, cost: usd(cost) };
  } finally {
    // The call's real cost is in `ai_calls`; the hold only covered the gap until it landed.
    await admitted.release();
  }
}

/**
 * The person's own page, fetched as politely as any careers page: the same fetcher, the same
 * `robots.txt` rules, the same per-host pacing. LinkedIn and the job boards never get here —
 * `libraryImportUrl` refuses them in the interface and again on the way out, because a stored row
 * outlives the validation that wrote it.
 */
async function websiteText(
  url: string,
  deps: WorkerDeps,
): Promise<{ text: string; truncated: boolean; retry?: string } | { error: string } | { busy: HostBusyError }> {
  const checked = libraryImportUrl(url);
  if ("error" in checked) return checked;
  const host = new URL(checked.url).hostname;
  const ctx = makeFetchContext(deps);
  let html: string;
  try {
    const response = await ctx.fetchText(checked.url, { timeoutMs: 20_000, maxBodyBytes: 3_000_000 });
    // A server having a bad minute is worth another go; a page that is gone or refused is the
    // person's to look at, and no number of retries turns a 404 into a profile.
    if (response.status >= 500) return { text: "", truncated: false, retry: `Could not fetch ${host}: HTTP ${response.status}` };
    if (response.status >= 400) {
      return { error: `The page at ${host} answered HTTP ${response.status}. Check that the link opens without signing in.` };
    }
    html = response.body;
  } catch (error) {
    if (error instanceof HostBusyError) return { busy: error };
    // A name that resolves into a private network is refused by the fetcher, and no retry makes it
    // public: that is an answer about the address, for the person to act on.
    if (error instanceof PrivateAddressError) {
      return { error: `${host} points into a private network, so AVA will not fetch it. Use the address of your own public page, or paste its text instead.` };
    }
    const message = (error as Error)?.message ?? "";
    // A site that will not have us is an answer, not an outage: robots.txt is respected here as
    // everywhere, and the person can paste the text instead.
    if (/robots\.txt/i.test(message)) {
      return { error: `${host} asks not to be fetched automatically. Paste the text of the page instead.` };
    }
    return { text: "", truncated: false, retry: `Could not fetch ${host}: ${message || "network error"}` };
  }
  let text = tidyDocumentText(stripHtml(html));
  if (text.length < JS_SHELL_TEXT && ctx.render) {
    // Nearly no text in the page means it is a shell waiting for its JavaScript, which is what
    // the renderer is for; a render that fails leaves what the plain fetch found.
    try {
      const rendered = await ctx.render(checked.url);
      if (rendered.html && (rendered.status === null || rendered.status < 400)) {
        const better = tidyDocumentText(stripHtml(rendered.html));
        if (better.length > text.length) text = better;
      }
    } catch (error) {
      log.warn("library import render failed", { url: checked.url, error: (error as Error).message });
    }
  }
  return capDocumentText(text);
}
