/** Opt-in A3 evaluation against an independently enumerated frozen page, with zero-cost regrading. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createAiEngine, PRICING } from "../packages/ai/src/index";
import { A3_EXTRACT_POSTINGS } from "../packages/ai/src/prompts";
import { compactDomForModel, applyRecipe, validateRecipe } from "../packages/core/src/ats/html";
import { normalizeUrl } from "../packages/core/src/normalize";
import { evaluationBudget } from "./evaluation-budget.mjs";
import { providerReadiness } from "./provider-readiness.mjs";

type Posting = { title: string; url: string; location?: string; department?: string };
type Recipe = { version: 1; listItem: string; title: string; link: string; location?: string; department?: string };
const args = process.argv.slice(2);
const valueAfter = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const model = process.env.DISCOVERY_EVAL_MODEL ?? "claude-sonnet-5";
const budget = evaluationBudget(Number(process.env.DISCOVERY_EVAL_MAX_USD ?? "0.45"));
const replayPath = valueAfter("--replay") ?? process.env.EXTRACTION_EVAL_REPLAY_REPORT;
const defaultOutput = replayPath ? replayPath.replace(/\.json$/i, ".regraded.json") : "/tmp/extraction-ai-evaluation.json";
const output = valueAfter("--output") ?? process.env.DISCOVERY_EVAL_OUTPUT ?? defaultOutput;
const oracleReportPath = "docs/live-snapshots/2026-09-20-extraction-accuracy/extraction-accuracy-report.json";

const hash = (body: string) => createHash("sha256").update(body).digest("hex");
const exact = (value: string | undefined) => value?.trim() ?? "";

function identityComparison(rows: Posting[], oracle: Posting[]) {
  const expected = new Set(oracle.map(posting => normalizeUrl(posting.url)));
  const actual = new Set(rows.map(posting => normalizeUrl(posting.url)));
  const truePositives = [...actual].filter(url => expected.has(url)).length;
  const falsePositives = [...actual].filter(url => !expected.has(url));
  const falseNegatives = [...expected].filter(url => !actual.has(url));
  return { truePositives, falsePositives, falseNegatives, precision: actual.size ? truePositives / actual.size : 0,
    recall: expected.size ? truePositives / expected.size : 0,
    exactIdentityMatch: falsePositives.length === 0 && falseNegatives.length === 0 };
}

function fieldComparison(rows: Posting[], oracle: Posting[]) {
  const actual = new Map(rows.map(posting => [normalizeUrl(posting.url), posting]));
  const rawExactMismatches: Array<{ url: string; field: "title" | "location"; expected: string; actual: string }> = [];
  const semanticMismatches: Array<{ url: string; field: "title" | "location"; expected: string; actual: string }> = [];
  const locationTokens = (value: string | undefined) => exact(value).split(",").map(token => token.trim()).join(",");
  let comparedFields = 0;
  for (const expected of oracle) {
    const observed = actual.get(normalizeUrl(expected.url));
    if (!observed) continue;
    comparedFields++;
    if (exact(observed.title) !== exact(expected.title)) {
      const mismatch = { url: expected.url, field: "title" as const, expected: exact(expected.title), actual: exact(observed.title) };
      rawExactMismatches.push(mismatch); semanticMismatches.push(mismatch);
    }
    if (expected.location !== undefined) {
      comparedFields++;
      const mismatch = { url: expected.url, field: "location" as const, expected: exact(expected.location), actual: exact(observed.location) };
      if (mismatch.actual !== mismatch.expected) rawExactMismatches.push(mismatch);
      if (locationTokens(observed.location) !== locationTokens(expected.location)) semanticMismatches.push(mismatch);
    }
    // Department is excluded because this source-specific oracle did not independently label it.
  }
  return { comparedFields, rawExactMatches: comparedFields - rawExactMismatches.length,
    rawExactAccuracy: comparedFields ? (comparedFields - rawExactMismatches.length) / comparedFields : null,
    rawExactMismatches, semanticMatches: comparedFields - semanticMismatches.length,
    semanticAccuracy: comparedFields ? (comparedFields - semanticMismatches.length) / comparedFields : null,
    semanticMismatches, rawExactPassed: comparedFields > 0 && rawExactMismatches.length === 0,
    semanticPassed: comparedFields > 0 && semanticMismatches.length === 0 };
}

function grade(rows: Posting[], oracle: Posting[]) {
  return { identity: identityComparison(rows, oracle), fields: fieldComparison(rows, oracle) };
}

function modelRecipeFieldMismatches(rows: Posting[], modelRows: Posting[]) {
  const actual = new Map(rows.map(posting => [normalizeUrl(posting.url), posting]));
  return modelRows.flatMap(expected => {
    const observed = actual.get(normalizeUrl(expected.url));
    if (!observed) return [];
    return (["title", "location", "department"] as const).flatMap(field => exact(observed[field]) === exact(expected[field]) ? [] : [{
      url: expected.url, field, modelExpected: exact(expected[field]), recipeActual: exact(observed[field]),
    }]);
  });
}

function loadOracle() {
  const oracleReport = JSON.parse(readFileSync(oracleReportPath, "utf8"));
  const source = oracleReport.cases.find((item: any) => item.id === "mozilla-html" && item.status === "completed");
  if (!source) throw new Error("Independent Mozilla oracle is missing or incomplete");
  const response = source.responses[0];
  const rawPath = `docs/live-snapshots/2026-09-20-extraction-accuracy/${response.file}`;
  const html = readFileSync(rawPath, "utf8");
  const rawHash = hash(html);
  if (rawHash !== response.sha256) throw new Error("Frozen Mozilla response hash differs from its provenance");
  const identities = source.oracle.identities as Posting[];
  if (!identities.length || identities.some(posting => !posting.title || !posting.url || posting.location === undefined)) {
    throw new Error("Independent Mozilla field oracle is empty or lacks title/location labels");
  }
  return { html, identities, source, response, rawPath, rawHash };
}

async function main() {
  if (replayPath && output === replayPath) throw new Error("Regrade output must differ from the original report so evidence is preserved");
  const frozen = loadOracle();
  const compact = compactDomForModel(frozen.html, frozen.source.sourceUrl);
  const prior = replayPath ? JSON.parse(readFileSync(replayPath, "utf8")) : undefined;
  const report: Record<string, any> = {
    at: new Date().toISOString(), model: prior?.model ?? model, mode: replayPath ? "zero_cost_regrade" : "provider_evaluation",
    status: "blocked", releaseAccepted: false, closureProof: false,
    closureLimitation: "A machine-derived oracle for one URL pattern and one page cannot prove the complete live posting set or authorise role closure.",
    sourceProvenance: { oracleReport: oracleReportPath, oracleClassification: "machine-derived independently implemented field oracle; not human labels",
      rawPath: frozen.rawPath, sourceUrl: frozen.source.sourceUrl, requestedUrl: frozen.response.url, finalUrl: frozen.response.finalUrl,
      fetchedAt: frozen.response.fetchedAt, sha256: frozen.rawHash, oracleIdentities: frozen.identities.length, replayReport: replayPath },
    compactInput: { maxChars: 60_000, chars: compact.text.length, truncated: compact.truncated },
    reproducibility: replayPath ? {
      originalGeneration: prior?.reproducibility?.generation ?? prior?.reproducibility ?? { promptSha256: "unknown", compactInputSha256: "unknown", note: "The original report predates reproducibility hashes." },
      regradeEnvironment: { promptSource: "packages/ai/src/prompts.ts#A3_EXTRACT_POSTINGS", promptSha256: hash(A3_EXTRACT_POSTINGS), compactInputSha256: hash(compact.text),
        note: "These hashes describe the current offline regrade environment, not the earlier provider call." },
    } : { generation: { promptSource: "packages/ai/src/prompts.ts#A3_EXTRACT_POSTINGS", promptSha256: hash(A3_EXTRACT_POSTINGS), compactInputSha256: hash(compact.text) } },
    limitation: "One frozen first-party HTML page with a machine-derived field oracle; not the 15-page human-labelled A3 set.",
  };
  const save = () => writeFileSync(output, JSON.stringify({ ...report,
    budget: replayPath ? { spentUsd: 0, records: [], sourceReportBudget: prior?.budget ?? null } : budget.snapshot() }, null, 2) + "\n");
  try {
    let extracted: { postings: Posting[]; recipe: Recipe | null; dropped?: number };
    if (prior) {
      if (prior.snapshot?.sha256 !== frozen.rawHash && prior.sourceProvenance?.sha256 !== frozen.rawHash) throw new Error("Replay report refers to a different frozen response hash");
      if (!Array.isArray(prior.extraction?.postings)) throw new Error("Replay report does not contain model postings to regrade");
      extracted = { postings: prior.extraction.postings, recipe: prior.recipe?.recipe ?? null, dropped: prior.extraction.dropped };
      report.regradedFrom = { path: replayPath, at: prior.at, status: prior.status, model: prior.model };
    } else {
      report.provider = await providerReadiness({ apiKey: process.env.ANTHROPIC_API_KEY, models: [model], prices: PRICING });
      if (report.provider.status !== "passed") throw new Error("Provider preflight blocked");
      const ai = createAiEngine({ apiKey: process.env.ANTHROPIC_API_KEY, getModel: () => model, reserve: budget.reserve, onUsage: budget.onUsage });
      const result = await ai.extractPostings({ pageUrl: frozen.source.sourceUrl, compactDom: compact.text, knownUrls: compact.knownUrls });
      if (!result) throw new Error("No model extraction");
      extracted = result;
    }
    const extractionGrade = grade(extracted.postings, frozen.identities);
    report.extraction = { ...extractionGrade, postings: extracted.postings, dropped: extracted.dropped ?? 0 };
    const recipeRows = extracted.recipe ? applyRecipe(frozen.html, frozen.source.sourceUrl, extracted.recipe) : [];
    const recipeGrade = grade(recipeRows, frozen.identities);
    report.recipe = extracted.recipe ? { recipe: extracted.recipe,
      validationAgainstModelOutput: validateRecipe(frozen.html, frozen.source.sourceUrl, extracted.recipe, extracted.postings),
      modelReplayFieldMismatches: modelRecipeFieldMismatches(recipeRows, extracted.postings), ...recipeGrade, producedRows: recipeRows }
      : { recipe: null, ...recipeGrade, producedRows: recipeRows, reason: "Model did not provide a reusable recipe" };
    const specThresholdPass = extractionGrade.identity.precision >= 0.98 && extractionGrade.identity.recall >= 0.9
      && recipeGrade.identity.precision >= 0.98 && recipeGrade.identity.recall >= 0.9
      && report.recipe.validationAgainstModelOutput?.ok === true;
    const exactIdentityMatch = extractionGrade.identity.exactIdentityMatch && recipeGrade.identity.exactIdentityMatch;
    const exactFieldMatch = extractionGrade.fields.rawExactPassed && recipeGrade.fields.rawExactPassed;
    const semanticFieldMatch = extractionGrade.fields.semanticPassed && recipeGrade.fields.semanticPassed;
    report.grades = { specThresholdPass, exactIdentityMatch, exactFieldMatch, semanticFieldMatch, compactInputComplete: !compact.truncated, closureProof: false,
      note: "Threshold agreement is evaluation evidence only. Even exact agreement with this machine oracle is not proof of the complete live listing." };
    report.status = specThresholdPass && exactIdentityMatch && semanticFieldMatch && !compact.truncated && !(replayPath ? false : budget.snapshot().exceeded)
      ? "automated_checks_passed" : "failed";
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
  }
  save();
  console.log(JSON.stringify({ status: report.status, mode: report.mode, spentUsd: replayPath ? 0 : budget.snapshot().spentUsd, output }));
  if (report.status !== "automated_checks_passed") process.exitCode = 1;
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
