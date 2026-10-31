/** Bounded, live qualification of role extraction and evidence mapping on invented data. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createAiEngine, createProviderClient, RecordingClient, promptSetVersion,
  type AiUsageRecord } from "../packages/ai/src/index";
import { CvLibrarySchema } from "../packages/core/src/cv";
import { validateCvRubric } from "../packages/core/src/cv-review";
import { cvTailoringEvidence, validateCvTailoringPlan } from "../packages/core/src/cv-tailoring";
import { cvEssentialOmissionIds, cvRecommendedPriorityIds, projectCvWritingLibrary,
  CvTargetingBriefSchema, cvEffectiveRubric } from "../packages/core/src/cv-targeting";
import { cvTargetingSource } from "../packages/core/src/cv-targeting-identity";
import { REPLAY_FIXTURE_DESCRIPTION, REPLAY_FIXTURE_LIBRARY, REPLAY_FIXTURE_MODEL }
  from "../apps/worker/src/cv-replay-fixture";
import { rankedReplayFixtureRequirements } from "../apps/worker/src/cv-replay-fixture";
import { installLiveEvaluationGuard } from "./live-evaluation-guard.mjs";

// Read only the provider credential needed by this probe; never connect to a database.
if (!process.env.ANTHROPIC_API_KEY && process.env.CV_EVAL_ENV_FILE) {
  const match = readFileSync(process.env.CV_EVAL_ENV_FILE, "utf8")
    .match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.*?)\s*$/mu);
  if (match) process.env.ANTHROPIC_API_KEY = match[1]!.replace(/^(['"])(.*)\1$/u, "$2");
}
const key = process.env.ANTHROPIC_API_KEY;
const model = process.env.CV_EVAL_MODEL;
const ledgerPath = process.env.CV_EVAL_LEDGER_PATH;
if (!key || model !== REPLAY_FIXTURE_MODEL || Number(process.env.CV_EVAL_MAX_USD) !== 10
  || !ledgerPath || !isAbsolute(ledgerPath) || !existsSync(ledgerPath))
  throw new Error("Preparation qualification needs the reviewed model, provider key and existing absolute $10 spend ledger.");
const outDir = resolve(process.env.CV_EVAL_OUTPUT_DIR ?? "/tmp/col-cv-preparation-evaluation-1030");
mkdirSync(outDir, { recursive: true });
const recording = resolve(outDir, "preparation-provider-recording.jsonl");
if (existsSync(recording)) throw new Error("Use a new output directory to preserve the previous provider recording.");
const prior = JSON.parse(readFileSync(ledgerPath, "utf8"));
const guard = installLiveEvaluationGuard({ model, maxUsd: 10, phases: {
  fixture: { maxUsd: 0, maxRequests: 0 }, cv: { maxUsd: 9, maxRequests: 7 },
  skills: { maxUsd: 2, maxRequests: 4 }, preparation: { maxUsd: 2, maxRequests: 4 },
}, prior, onDebit: (snapshot: unknown) => writeFileSync(ledgerPath, JSON.stringify(snapshot, null, 2) + "\n") });
const usage: AiUsageRecord[] = [];
try {
  guard.setPhase("preparation");
  const client = new RecordingClient(createProviderClient(key), { path: recording, secrets: [key] });
  const ai = createAiEngine({ client, getModel: () => model, useServerFallback: false, retries: 0,
    onUsage: record => { usage.push(record); }, logger: () => {} });
  const library = CvLibrarySchema.parse(REPLAY_FIXTURE_LIBRARY);
  const start = performance.now();
  const rubricStart = performance.now();
  const proposedRubric = await ai.analyseCvJob(REPLAY_FIXTURE_DESCRIPTION, { stage: "rubric" });
  if (!proposedRubric) throw new Error("No validated role rubric.");
  const sourceRubric = validateCvRubric(REPLAY_FIXTURE_DESCRIPTION, proposedRubric);
  const requirements = process.env.CV_EVAL_RANKED_FIXTURE === "1" ? rankedReplayFixtureRequirements(sourceRubric) : undefined;
  const rubric = requirements ? cvEffectiveRubric(sourceRubric, requirements) : sourceRubric;
  const rubricMs = performance.now() - rubricStart;
  const planStart = performance.now();
  const proposedPlan = await ai.planCvTailoring({ rubric, library }, { stage: "planning" });
  if (!proposedPlan) throw new Error("No validated evidence plan.");
  const plan = validateCvTailoringPlan(proposedPlan, rubric, cvTailoringEvidence(library), library);
  const planMs = performance.now() - planStart;
  const entries = library.entries.map(entry => ({ entryId: entry.id,
    treatment: entry.id === "ev-calder" ? "omit" : entry.id === "ev-manager" ? "summarise" : "feature" }));
  const brief = CvTargetingBriefSchema.parse({ version: 1,
    source: cvTargetingSource(1, library, REPLAY_FIXTURE_DESCRIPTION), entries,
    presentation: { maxPages: 2, bodySizePt: 12 },
    priority: { state: "unprepared", emphasisRequirementIds: [], acknowledgedEssentialOmissionIds: [] } });
  const report = { kind: "cv-preparation-live-probe", at: new Date().toISOString(),
    source: "provider", syntheticCandidate: true, promptSetVersion: promptSetVersion(), model,
    outcome: "passed", sourceRubric, ...(requirements ? { userRequirements: requirements } : {}), rubric, plan, recommendedEmphasis: cvRecommendedPriorityIds(rubric),
    essentialOmissions: cvEssentialOmissionIds(plan, rubric, projectCvWritingLibrary(library, brief)),
    validation: { exactJobQuotes: true, completeRequirementMapping: true, exactEvidenceQuotes: true },
    calls: usage.length, costUsd: usage.reduce((sum, record) => sum + record.costUsd, 0),
    timing: { rubricMs: Math.round(rubricMs), planningMs: Math.round(planMs), totalMs: Math.round(performance.now() - start),
      scope: "One local live-provider sample; not a hosted before/after benchmark." },
    recordingSha256: createHash("sha256").update(readFileSync(recording)).digest("hex"),
    transport: guard.snapshot() };
  writeFileSync(resolve(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ outcome: report.outcome, calls: report.calls, costUsd: report.costUsd,
    requirements: rubric.requirements.length, timing: report.timing, totalLedgerUsd: report.transport.totalUpperBoundUsd }));
} catch {
  writeFileSync(resolve(outDir, "failure.json"), JSON.stringify({ outcome: "failed",
    phase: "preparation", calls: usage.length, transport: guard.snapshot() }, null, 2) + "\n");
  console.error("Preparation qualification failed. Inspect its redacted report; no provider text or credentials were logged.");
  process.exitCode = 1;
} finally { guard.restore(); }
