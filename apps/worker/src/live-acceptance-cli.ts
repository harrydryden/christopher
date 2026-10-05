import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { validateReferenceSnapshot, type ReferencePostingSnapshot } from "./live-acceptance-postings";
import { assessLiveAcceptanceCorpus } from "./live-acceptance-corpus";
import { LIVE_ACCEPTANCE_CASES } from "./live-acceptance-manifest";
import { resolveLiveAcceptanceConcurrency, resolveLiveAcceptanceDiscoveryBudget, runLiveAcceptanceCase, summariseLiveAcceptance, liveAcceptanceVerdict, type LiveAcceptanceResult } from "./live-acceptance";
import { PoliteFetcher, userAgentFor } from "./fetcher";
import { BrowserRenderer } from "./browser";
import { createAiEngine, type AiUsageRecord } from "@col/ai";
import { DEFAULT_SYSTEM_SETTINGS } from "@col/core";
import { createLiveAcceptanceAiBudget } from "./live-acceptance-ai";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const limitRaw = valueAfter(args, "--limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : LIVE_ACCEPTANCE_CASES.length;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIVE_ACCEPTANCE_CASES.length) throw new Error(`--limit must be 1-${LIVE_ACCEPTANCE_CASES.length}`);
  const ids = valueAfter(args, "--ids")?.split(",").map(v => v.trim()).filter(Boolean);
  const selected = (ids ? LIVE_ACCEPTANCE_CASES.filter(item => ids.includes(item.id)) : LIVE_ACCEPTANCE_CASES).slice(0, limit);
  if (!selected.length) throw new Error("no manifest cases selected");
  const unknown = ids?.filter(id => !LIVE_ACCEPTANCE_CASES.some(item => item.id === id)) ?? [];
  if (unknown.length) throw new Error(`unknown case id(s): ${unknown.join(", ")}`);
  const corpusCoverage = assessLiveAcceptanceCorpus(selected);
  if (args.includes("--check-corpus")) {
    process.stdout.write(`${JSON.stringify({ mode: "offline_corpus_composition", goldenSetCompositionQualified: corpusCoverage.qualifies, corpusCoverage }, null, 2)}\n`);
    if (!corpusCoverage.qualifies) process.exitCode = 2;
    return;
  }
  const discoveryOnly = args.includes("--discovery-only");
  const discoveryBudgetRaw = valueAfter(args, "--discovery-budget");
  if (args.includes("--discovery-budget") && !discoveryBudgetRaw) throw new Error("--discovery-budget requires diagnostic or production");
  const discoveryBudget = resolveLiveAcceptanceDiscoveryBudget(discoveryBudgetRaw);
  const browserEnabled = args.includes("--browser");
  const aiEnabled = args.includes("--ai");
  const aiCapRaw = valueAfter(args, "--ai-max-usd");
  if (aiEnabled && !aiCapRaw) throw new Error("--ai requires an explicit --ai-max-usd cap");
  if (!aiEnabled && aiCapRaw) throw new Error("--ai-max-usd requires --ai");
  const aiCapUsd = aiCapRaw ? Number(aiCapRaw) : 0;
  const aiModel = process.env.LIVE_ACCEPTANCE_AI_MODEL ?? DEFAULT_SYSTEM_SETTINGS.defaultModel;
  const concurrency = resolveLiveAcceptanceConcurrency(valueAfter(args, "--concurrency"), browserEnabled, aiEnabled);
  if (aiEnabled && concurrency.value !== 1) throw new Error("--ai requires --concurrency 1 so its run-level cap and case attribution remain exact");
  const references = new Map<string, ReferencePostingSnapshot>();
  const referencePath = valueAfter(args, "--posting-references");
  if (args.includes("--posting-references") && !referencePath) throw new Error("--posting-references requires a JSON path");
  if (referencePath) {
    const path = resolve(referencePath);
    const document = JSON.parse(await readFile(path, "utf8")) as { snapshots?: unknown };
    if (!Array.isArray(document.snapshots)) throw new Error("Posting references must contain a snapshots array");
    for (const value of document.snapshots) {
      const snapshot = validateReferenceSnapshot(value);
      if (references.has(snapshot.caseId)) throw new Error(`Duplicate posting reference: ${snapshot.caseId}`);
      if (!LIVE_ACCEPTANCE_CASES.some(item => item.id === snapshot.caseId)) throw new Error(`Unknown posting reference: ${snapshot.caseId}`);
      if (snapshot.rawPath) {
        const raw = await readFile(resolve(dirname(path), snapshot.rawPath));
        if (createHash("sha256").update(raw).digest("hex") !== snapshot.rawSha256) throw new Error(`Posting reference raw hash mismatch: ${snapshot.caseId}`);
      }
      references.set(snapshot.caseId, snapshot);
    }
  }

  const results: LiveAcceptanceResult[] = [];
  const fetcher = new PoliteFetcher({
    userAgent: userAgentFor(process.env.CONTACT_EMAIL ?? "col-live-acceptance@example.invalid"),
    respectRobots: () => true,
  });
  const browser = browserEnabled ? new BrowserRenderer({
    userAgent: userAgentFor(process.env.CONTACT_EMAIL ?? "col-live-acceptance@example.invalid"),
    beforeNavigate: host => fetcher.waitForHost(host),
    allowNavigate: (url, allowHost) => fetcher.assertRobotsAllowed(url, allowHost),
    concurrency: 1,
  }) : undefined;
  const aiUsage: Array<Pick<AiUsageRecord, "callSite" | "model" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "costUsd" | "durationMs" | "ok" | "error" | "failure" | "refType" | "refId">> = [];
  const aiBudget = aiEnabled ? createLiveAcceptanceAiBudget(aiModel, aiCapUsd) : undefined;
  const ai = aiEnabled ? createAiEngine({
    apiKey: process.env.ANTHROPIC_API_KEY,
    getModel: () => aiModel,
    reserve: aiBudget!.reserve,
    onUsage: record => {
      aiBudget!.onUsage(record);
      const { callSite, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, durationMs, ok, error, failure, refType, refId } = record;
      aiUsage.push({ callSite, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, durationMs, ok, error, failure, refType, refId });
    },
  }) : undefined;
  if (aiEnabled && !ai!.enabled) throw new Error("--ai requires ANTHROPIC_API_KEY");
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency.value, selected.length) }, async () => {
    while (next < selected.length) {
      const index = next++;
      const item = selected[index]!;
      process.stderr.write(`[${index + 1}/${selected.length}] ${item.company}\n`);
      const hooks = ai ? {
        chooseCareersLinks: async (input: Parameters<typeof ai.chooseCareersLinks>[0]) => (await ai.chooseCareersLinks(input, { refType: "live_acceptance_case", refId: item.id })) ?? [],
        classifyPage: async (input: Parameters<typeof ai.classifyPage>[0]) => (await ai.classifyPage(input, { refType: "live_acceptance_case", refId: item.id })) ?? { kind: "other" as const, confidence: 0 },
      } : undefined;
      const result = await runLiveAcceptanceCase(item, { discoveryOnly, fetcher, browser, ai: hooks,
        maxFetches: discoveryBudget.maxFetches, maxDurationMs: discoveryBudget.maxDurationMs,
        reference: references.get(item.id), referenceRawHashVerified: Boolean(references.get(item.id)?.rawPath) });
      results[index] = result;
    }
  });
  try {
    await Promise.all(workers);
  } finally {
    await browser?.close();
  }
  const metrics = summariseLiveAcceptance(selected, results);
  const acceptance = liveAcceptanceVerdict(selected, metrics, LIVE_ACCEPTANCE_CASES.map(item => item.id));
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    mode: discoveryOnly ? "discovery_only" : "discovery_and_extraction",
    discoveryBudget: {
      ...discoveryBudget,
      note: discoveryBudget.mode === "diagnostic"
        ? "Legacy bounded 16-fetch/45-second diagnostic for comparison with earlier reports; this is not the production discovery crawl budget."
        : "Matches the production discovery crawl defaults of 40 fetches and 120 seconds per case; the worker task has its own deadline.",
    },
    concurrency: {
      cases: concurrency.value,
      source: concurrency.source,
      productionShape: concurrency.value === 1,
      note: concurrency.value === 1
        ? `Serial case execution avoids charging a case's ${discoveryBudget.maxDurationMs / 1000}-second discovery budget for time queued behind the shared browser or AI lane; productionShape describes concurrency only.`
        : "Concurrent case execution is a stress diagnostic; shared browser queue wait counts inside each case's discovery budget.",
    },
    browser: browserEnabled ? { enabled: true, implementation: "BrowserRenderer", aiEnabled } : { enabled: false, skipCode: "browser_not_requested", aiEnabled },
    ai: aiEnabled ? {
      enabled: true,
      implementation: "production AiEngine A1/A2 hooks",
      modelRequested: aiModel,
      modelSource: process.env.LIVE_ACCEPTANCE_AI_MODEL ? "LIVE_ACCEPTANCE_AI_MODEL" : "DEFAULT_SYSTEM_SETTINGS.defaultModel",
      ...aiBudget!.snapshot(),
      calls: aiUsage,
    } : { enabled: false, skipCode: "ai_not_requested", calls: [] },
    limitations: [
      "This is a live observation, so role counts and pages can change during the run.",
      "Extraction starts from each labelled source, independently of discovery. Completion is not an end-to-end success or posting-recall claim.",
      "HTML diagnostics traverse HTTP/browser listings and reject unverified empty results; they do not exercise the worker cache, learned recipes or AI extraction recovery.",
      "Machine-enumerated posting references produce diagnostic comparisons only; they do not qualify human-reviewed full-site recall/precision.",
      "A null metric means the required independent label does not exist; it is not a pass.",
      `${browserEnabled ? "Production BrowserRenderer fallback is enabled" : "Browser fallback is disabled"}; ${aiEnabled ? "production A1/A2 AI fallback is enabled under the reported process-local cap" : "AI fallback is disabled"}; no database or account data is read or written.`,
      aiEnabled ? "AI costs are computed from provider-reported token usage and checked repository pricing; they are not an invoice or provider-side spending limit." : "No paid model request is made without --ai and an explicit --ai-max-usd cap.",
    ],
    scope: { selectedCaseIds: selected.map(item => item.id), requiredCaseIds: LIVE_ACCEPTANCE_CASES.map(item => item.id), fullCorpusSelected: selected.length === LIVE_ACCEPTANCE_CASES.length },
    goldenSetCompositionQualified: corpusCoverage.qualifies,
    corpusCoverage,
    acceptanceCriterionScope: "This verdict covers the reporter's labelled source choice, extraction and corpus-composition checks only; SPEC §9 manual resolution, recipe reproduction and the 50-company operating budget require separate evidence.",
    postingReferences: referencePath ? { path: referencePath, snapshots: [...references.values()] } : null,
    acceptance,
    metrics,
    cases: selected.map(item => ({ manifest: item, result: results.find(result => result.id === item.id) })),
  };
  const defaultName = `docs/live-acceptance-${report.generatedAt.replace(/[:.]/g, "-")}.json`;
  const output = resolve(valueAfter(args, "--output") ?? defaultName);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${output}\n${JSON.stringify(report.metrics, null, 2)}\n`);
  if (acceptance.verdict === "fail") process.exitCode = 1;
  else if (acceptance.verdict === "blocked") process.exitCode = 2;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
