/** One authorised, capped provider pass on an invented CV in a local disposable database. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "../packages/db/node_modules/drizzle-orm/index.js";
import { createScriptedAiClient } from "../apps/web/test/scripted-ai-client";
import { createDeps } from "../apps/worker/src/context";
import { publishReplayFixture, REPLAY_FIXTURE_LIBRARY } from "../apps/worker/src/cv-replay-fixture";
import { readRecordingHeader, recordCvDraft, replayFromRecording } from "../apps/worker/src/cv-replay";
import { readEnv } from "../apps/worker/src/env";
import { handleSuggestCvSkills } from "../apps/worker/src/handlers/cv-skill-suggestions";
import { cvHighlightedSkillRows, cvSkillDraftContext, cvSkillEvidenceRows, cvSkillSuggestionInputHash, groundedCvSkillSuggestions } from "../packages/core/src/index";
import { renderCvPdfWithReport } from "../packages/core/src/cv-pdf";
import { CvLibrarySchema } from "../packages/core/src/cv";
import { CvTargetingBriefSchema, cvEligibleSkillLibrary, cvSkillSourcePolicy } from "../packages/core/src/cv-targeting";
import { schema, type Task } from "../packages/db/src/index";
import { runMigrations } from "../packages/db/src/migrate";
import { installLiveEvaluationGuard } from "./live-evaluation-guard.mjs";

const envFile = process.env.CV_EVAL_ENV_FILE;
if (!envFile) throw new Error("CV_EVAL_ENV_FILE must name the existing local evaluation credentials file.");
for (const line of readFileSync(envFile, "utf8").split(/\r?\n/u)) {
  const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/u);
  if (!match || process.env[match[1]!]) continue;
  const raw = match[2]!;
  process.env[match[1]!] = /^(['"]).*\1$/u.test(raw) ? raw.slice(1, -1) : raw;
}
const model = process.env.CV_EVAL_MODEL;
const key = process.env.ANTHROPIC_API_KEY;
const maxUsd = Number(process.env.CV_EVAL_MAX_USD);
const dbUrl = process.env.DATABASE_URL;
const targeted = process.env.CV_EVAL_TARGETED_FIXTURE === "1";
const ranked = process.env.CV_EVAL_RANKED_FIXTURE === "1";
if (process.env.CV_EVAL_RANKED_FIXTURE && (!ranked || !targeted))
  throw new Error("Ranked qualification requires both ranked and targeted fixture modes.");
if (process.env.CV_EVAL_TARGETED_FIXTURE && !targeted)
  throw new Error("CV_EVAL_TARGETED_FIXTURE must be 1 when set.");
if (model !== "claude-fable-5-1" || !key || maxUsd !== 10 || !dbUrl)
  throw new Error("Evaluation needs the reviewed model, provider key, $10 cap and local database URL.");
const database = new URL(dbUrl);
const localDatabaseName = process.env.CV_EVAL_DATABASE_NAME ?? "col_cv_live_eval_1028";
if (!["col_cv_live_eval_1028", "col_cv_live_eval_release_1028", "col_cv_targeted_eval_1030"].includes(localDatabaseName))
  throw new Error("Evaluation database name is not a reviewed disposable fixture database.");
if (!["127.0.0.1", "localhost"].includes(database.hostname)
  || database.port !== "55449" || database.pathname !== `/${localDatabaseName}`)
  throw new Error("Evaluation refuses any database other than the dedicated local disposable database.");
process.env.COL_DISABLE_BROWSER = "1";
const outDir = resolve(process.env.CV_EVAL_OUTPUT_DIR ?? "/tmp/col-cv-live-evaluation-1028");
mkdirSync(outDir, { recursive: true });
const historicalLedgerPath = "/tmp/col-cv-live-evaluation-1028/guard-ledger.json";
const ledgerPath = process.env.CV_EVAL_LEDGER_PATH ?? historicalLedgerPath;
if (!isAbsolute(ledgerPath) || (localDatabaseName !== "col_cv_live_eval_1028" && ledgerPath === historicalLedgerPath))
  throw new Error("The release fixture requires its explicit, separate absolute spend ledger path.");
if (targeted !== (localDatabaseName === "col_cv_targeted_eval_1030"))
  throw new Error("Targeted evaluation needs its dedicated local database and explicit mode together.");
const prior = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : undefined;
const guard = installLiveEvaluationGuard({ model, maxUsd, phases: {
  // Ranked qualification extends the same ledger to a new scenario, retaining its cumulative $10 cap.
  fixture: { maxUsd: 0, maxRequests: 0 }, cv: { maxUsd: 9, maxRequests: ranked ? 21 : 7 }, skills: { maxUsd: 2, maxRequests: ranked ? 8 : 4 },
}, prior, onDebit: snapshot => writeFileSync(ledgerPath, JSON.stringify(snapshot, null, 2) + "\n") });
guard.setPhase("fixture");
let deps: Awaited<ReturnType<typeof createDeps>> | undefined;
try {
  // The SDK captures fetch at construction; install the guard before createDeps makes any client.
  deps = await createDeps(readEnv());
  deps.disableServerFallback = true;
  await runMigrations(deps.db);
  const resumeAuthorFrom = process.env.CV_EVAL_RESUME_AUTHOR_FROM;
  const skillsOnlyFrom = process.env.CV_EVAL_SKILLS_ONLY_FROM;
  const sourceRecording = skillsOnlyFrom ?? resumeAuthorFrom;
  const fixtureEmail = targeted ? "cv-targeted-live-fixture-1030@example.invalid" : "cv-live-release-fixture-1028@example.invalid";
  const draft = sourceRecording
    ? await deps.db.query.cvDrafts.findFirst({ where: eq(schema.cvDrafts.id, readRecordingHeader(sourceRecording).meta?.draftId ?? "") })
    : await publishReplayFixture(deps, createScriptedAiClient({ barrierMs: 200, targetedSignpost: targeted }).client,
      fixtureEmail, { targeted, ranked });
  if (!draft) throw new Error("The provider-recorded synthetic draft is unavailable for resume.");
  if (targeted !== (draft.targetingBrief?.priority.state === "confirmed"))
    throw new Error("The source recording does not match the requested targeting mode.");
  if (ranked && !draft.targetingBrief?.priority.requirements?.some(row => row.id.startsWith("u:")))
    throw new Error("Ranked qualification requires the edited synthetic priority list.");
  if (draft.model !== model) throw new Error("Synthetic draft model does not match the authorised provider model.");
  const [fixtureUser] = await deps.db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, draft.userId));
  if (fixtureUser?.email !== fixtureEmail)
    throw new Error("The source recording does not belong to the reviewed synthetic fixture account.");
  if (resumeAuthorFrom && !skillsOnlyFrom) {
    const dry = await replayFromRecording(deps, draft.id, resumeAuthorFrom);
    if (dry.report.misses.some(miss => miss.promptId === "cv.author")
      || !dry.report.misses.some(miss => miss.promptId === "cv.review"))
      throw new Error("The current author request did not exactly match the provider recording.");
    // Two possible review requests at the most recent observed bound plus the full skill phase
    // must fit before any more paid transport. The guard still checks each exact request.
    const neededUsd = 2 * 1.85032 + 2;
    if (guard.snapshot().totalUpperBoundUsd + neededUsd > maxUsd)
      throw new Error("Live evaluation spend ceiling reached before remaining phases fit.");
    if (process.env.CV_EVAL_DRY_RUN === "1") throw new Error("EVAL_DRY_RUN_READY");
  }
  let replayed;
  if (skillsOnlyFrom) {
    replayed = await replayFromRecording(deps, draft.id, skillsOnlyFrom);
    if (replayed.report.unverified || replayed.report.outcome !== "published" || replayed.report.misses.length)
      throw new Error("The provider CV recording was not a valid local source for the separate skill probe.");
    if (replayed.report.grade?.passed !== true)
      throw new Error("The provider recording did not pass its own recorded-baseline replay grade.");
    writeFileSync(resolve(outDir, "cv-replay-report.json"), JSON.stringify(replayed.report, null, 2) + "\n");
    if (process.env.CV_EVAL_OFFLINE_REPORT_ONLY === "1") throw new Error("EVAL_OFFLINE_REPORT_READY");
  } else {
    guard.setPhase("cv");
    const recording = resolve(outDir, "cv-live-provider-recording.jsonl");
    const recorded = await recordCvDraft(deps, draft.id, { path: recording, ...(resumeAuthorFrom ? { resumeAuthorFrom } : {}) });
    writeFileSync(resolve(outDir, "cv-recorded-report.json"), JSON.stringify(recorded.report, null, 2) + "\n");
    if (recorded.report.unverified || recorded.report.outcome !== "published"
      || recorded.report.grade?.invariants.claimsSupported !== true
      || recorded.report.grade?.invariants.pageLimitMet !== true)
      throw new Error("The live CV rebuild did not publish with supported claims inside the page limit.");
    replayed = await replayFromRecording(deps, draft.id, recording);
    if (replayed.report.unverified || replayed.report.outcome !== "published" || replayed.report.grade?.passed !== true
      || replayed.report.misses.length)
      throw new Error("The offline replay of the real provider recording did not qualify.");
    writeFileSync(resolve(outDir, "cv-replay-report.json"), JSON.stringify(replayed.report, null, 2) + "\n");
  }

  if (!replayed.content) throw new Error("The qualified replay did not retain its exact rebuilt wording.");
  const rendered = await renderCvPdfWithReport(replayed.content);
  writeFileSync(resolve(outDir, "qualified-cv.pdf"), rendered.pdf);
  writeFileSync(resolve(outDir, "qualified-cv.json"), JSON.stringify({ content: replayed.content,
    pageCount: rendered.pageCount, maxPages: rendered.maxPages, layout: rendered.layout }, null, 2) + "\n");

  const [fixtureLibrary] = await deps.db.select({ version: schema.cvLibraries.version, content: schema.cvLibraries.content })
    .from(schema.cvLibraries).where(eq(schema.cvLibraries.userId, draft.userId));
  if (fixtureLibrary) {
    if (fixtureLibrary.version !== 1 || !isDeepStrictEqual(fixtureLibrary.content, REPLAY_FIXTURE_LIBRARY))
      throw new Error("The existing local fixture Library differs from the recorded synthetic source.");
  } else {
    await deps.db.insert(schema.cvLibraries).values({ userId: draft.userId, version: 1, content: REPLAY_FIXTURE_LIBRARY });
  }
  const brief = draft.targetingBrief ? CvTargetingBriefSchema.parse(draft.targetingBrief) : null;
  const skillLibrary = cvEligibleSkillLibrary(CvLibrarySchema.parse(REPLAY_FIXTURE_LIBRARY), brief);
  const rows = cvSkillEvidenceRows(skillLibrary);
  const highlighted = cvHighlightedSkillRows(draft.content!);
  const [run] = await deps.db.insert(schema.cvSkillSuggestionRuns).values({ userId: draft.userId, draftId: draft.id,
    libraryVersion: 1, inputHash: cvSkillSuggestionInputHash(1, draft.id, draft.jobDescription, rows, highlighted,
      cvSkillDraftContext(draft.content!), draft.revision, cvSkillSourcePolicy(brief)) }).returning();
  const beforeDraftRevision = draft.revision;
  guard.setPhase("skills");
  await handleSuggestCvSkills({ type: "suggest_cv_skills", payload: { userId: draft.userId, draftId: draft.id, runId: run!.id,
    baseRevision: draft.revision, draftContext: cvSkillDraftContext(draft.content!) } } as Task, deps);
  const [result] = await deps.db.select().from(schema.cvSkillSuggestionRuns).where(eq(schema.cvSkillSuggestionRuns.id, run!.id));
  const calls = await deps.db.select({ promptId: schema.aiCalls.promptId, costUsd: schema.aiCalls.costUsd, ok: schema.aiCalls.ok })
    .from(schema.aiCalls).where(and(eq(schema.aiCalls.refId, run!.id), eq(schema.aiCalls.userId, draft.userId)));
  const [afterDraft] = await deps.db.select({ revision: schema.cvDrafts.revision }).from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  const libraries = await deps.db.select({ version: schema.cvLibraries.version }).from(schema.cvLibraries).where(eq(schema.cvLibraries.userId, draft.userId));
  if (result?.status !== "ready" || !result.suggestions.length || calls.length !== 2
    || !calls.every(call => call.ok) || new Set(calls.map(call => call.promptId)).size !== 2
    || !calls.some(call => call.promptId === "cv.skill_suggestions") || !calls.some(call => call.promptId === "cv.skill_verify")
    || afterDraft?.revision !== beforeDraftRevision || libraries.length !== 1 || libraries[0]?.version !== 1)
    throw new Error("The live skill proposal/verification path did not satisfy its two-call, read-only contract.");
  if (result.suggestions.length > 10 || result.suggestions.some(item => item.label.trim().split(/\s+/u).length > 3
    || !rows.some(row => row.id === item.sourceId && row.text.includes(item.evidenceQuote))
    || !draft.jobDescription.includes(item.roleQuote)))
    throw new Error("The live suggestions failed bounded label or quotation checks.");
  const skillReport = {
    kind: "cv-skill-suggestions-live-probe", at: new Date().toISOString(), promptSetVersion: replayed.report.promptSetVersion,
    syntheticCandidate: true, source: "provider", model, outcome: "ready", verifiedCalls: calls.map(call => ({ promptId: call.promptId, costUsd: call.costUsd })),
    cvQualification: replayed.report.grade?.passed === true ? "passed" : "failed_no_essential_regressed",
    selectedOnlyPersistence: "covered by isolated integration tests; this paid probe makes no Library or CV change",
    suggestionCount: result.suggestions.length, categoryCount: new Set(result.suggestions.map(item => item.category.toLocaleLowerCase("en-GB"))).size,
    suggestions: result.suggestions.map(item => ({ category: item.category, label: item.label, sourceId: item.sourceId,
      evidenceQuote: item.evidenceQuote, roleQuote: item.roleQuote })),
    transport: guard.snapshot(),
  };
  writeFileSync(resolve(outDir, "cv-skill-live-probe.json"), JSON.stringify(skillReport, null, 2) + "\n");
  console.log(JSON.stringify({ status: "passed", cv: { promptSetVersion: replayed.report.promptSetVersion,
    calls: replayed.report.calls, costUsd: replayed.report.costUsd }, skills: { calls: calls.length,
    costUsd: Number(calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0).toFixed(6)),
    suggestions: result.suggestions.length, categories: skillReport.categoryCount }, guard: guard.snapshot(), outDir }));
} catch (error) {
  if (error instanceof Error && ["EVAL_DRY_RUN_READY", "EVAL_OFFLINE_REPORT_READY"].includes(error.message)) {
    console.log(JSON.stringify({ status: "dry-run-ready", remainingUsd: Number((maxUsd - guard.snapshot().totalUpperBoundUsd).toFixed(6)) }));
  } else {
  // Provider errors can include request text or identifiers. No raw error or response body is logged.
  console.error(JSON.stringify({ status: "failed", reason: error instanceof Error && /spend ceiling/u.test(error.message)
    ? "authorised spend ceiling reached" : "provider or qualification check failed; inspect redacted local reports", guard: guard?.snapshot() ?? null }));
  process.exitCode = 1;
  }
} finally {
  guard?.restore();
  await deps?.close();
}
