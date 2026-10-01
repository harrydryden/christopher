import { withResourceLease } from "../lease";
import { analyzeTables, GATE_ANALYZE_THRESHOLD, GATE_TABLES } from "../analyze";
import { schema, enqueueStandard, latestApplicationFor, latestCvLibrary, reevaluateGate, appendProfile, latestProfileFor, listUserIds, seedTagVocabulary, lockAccountScoreInput, lockScoreModelInput, accountCanScore, type ScoreState, type Task } from "@ava/db";
import { decisionDigest, PROMPTS, resolveRoute, routedModel, type AiFailure, type ScoreJobInput, type ScoreJobResult } from "@ava/ai";
import { eligibleCvEvidence, evidenceHeading, responsibilityRows, scoringEvidence, sha1, modelForCallSite, type CvLibrary, type ScoringEvidenceBlock, type TaskPayloads } from "@ava/core";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { WorkerDeps } from "../context";
import { aiBudgetStop } from "../context";
import { ACCOUNT_BUDGET_REFUSED, withinAccountBudget } from "../budget";
import { log } from "../log";
import { admitScores } from "../score-admission";
import { scoreLocationInput } from "../score-location";
import { loadUserSettings } from "../settings";

/** What a handler finishes with when its account has no room left for the call it was about to make. */
const BUDGET_SKIP = { skipped: "account ai budget exceeded" } as const;

/** Every account carries the seed vocabulary; new accounts get it at creation, this covers older ones. */
export async function ensureSeedTags(deps: WorkerDeps): Promise<void> {
  for (const userId of await listUserIds(deps.db)) await seedTagVocabulary(deps.db, userId);
}

export async function handleTagReason(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { decisionId } = task.payload as unknown as { decisionId: string };
  const [decision] = await deps.db.select().from(schema.decisions).where(eq(schema.decisions.id, decisionId)).limit(1);
  if (!decision) return { skipped: "decision not found" };
  if (decision.superseded || decision.tagsEdited) return { skipped: "decision superseded or tags edited by user" };
  if (!decision.reason.trim()) return { skipped: "no reason text" };
  const tagStop = await aiBudgetStop(deps, decision.userId);
  if (tagStop) return { skipped: tagStop };

  await seedTagVocabulary(deps.db, decision.userId);
  const vocab = await deps.db.select({ tag: schema.tagVocabulary.tag }).from(schema.tagVocabulary)
    .where(and(eq(schema.tagVocabulary.userId, decision.userId), eq(schema.tagVocabulary.accepted, true)));
  const result = await withinAccountBudget(deps.ai.tagReason(
    {
      reason: decision.reason,
      decision: decision.decision,
      job: { title: decision.jobTitle, company: decision.companyName, location: decision.jobLocation ?? undefined, department: decision.jobDepartment ?? undefined },
      vocabulary: vocab.map((v) => v.tag),
    },
    { refType: "decision", refId: decision.id, userId: decision.userId, signal: deps.signal },
  ));
  if (result === ACCOUNT_BUDGET_REFUSED) return BUDGET_SKIP;
  if (!result) return { skipped: "no ai result" };

  // Behind the task's fence, so a run the queue has given up on writes nothing after its retry began.
  await deps.db.transaction(async tx => {
    await deps.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
    await lockAccountScoreInput(tx as unknown as WorkerDeps["db"], decision.userId, "exclusive");
    const tagged = await tx.update(schema.decisions).set({ tags: result.tags }).where(and(eq(schema.decisions.id, decision.id), eq(schema.decisions.userId, decision.userId), eq(schema.decisions.tagsEdited, false), eq(schema.decisions.superseded, false)))
      .returning({ id: schema.decisions.id });
    if (tagged.length && await accountCanScore(tx as unknown as WorkerDeps["db"], decision.userId))
      await enqueueStandard(tx as unknown as WorkerDeps["db"], "rescore_all", { userId: decision.userId, onlyInTable: true });
    if (result.proposedNewTags.length) {
      await tx
        .insert(schema.tagVocabulary)
        .values(result.proposedNewTags.map((t) => ({ userId: decision.userId, tag: t.tag, description: t.description, createdBy: "model" as const, accepted: false })))
        .onConflictDoNothing();
    }
  });
  return { tags: result.tags, proposed: result.proposedNewTags.length };
}

/**
 * Why this account's view of a role carries the score it carries, recorded where the table reads
 * it. A blank score covered five situations and the row could not say which; every outcome of
 * this handler now names its own. Silent when the account has no view of the role: there is no
 * row to say it on, which is itself the `ineligible` case.
 */
export async function markScoreState(deps: WorkerDeps, userId: string, jobId: string, state: ScoreState) {
  await deps.db.update(schema.userJobs).set({ scoreState: state, scoreStateAt: deps.now() })
    .where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId),
      sql`${schema.userJobs.scoreState} is distinct from ${state}`));
}

/** One account's score for one role, read and ready to be asked for: what the model is shown and what the score will record. */
export interface PreparedScore {
  userId: string;
  jobId: string;
  input: ScoreJobInput;
  /** What the score was computed from, stored with it so an unchanged rerun skips the call. */
  fingerprint: string;
  /** Monotonic request number on this account's view; timestamps cannot order same-ms answers. */
  attemptVersion: number;
  profileVersion: number | null;
  /** When the inputs were read. */
  preparedAt: Date;
}

async function scoreInputs(db: WorkerDeps["db"], userId: string,
  job: typeof schema.jobs.$inferSelect, view: typeof schema.userJobs.$inferSelect,
  settings: Awaited<ReturnType<WorkerDeps["userSettings"]>>) {
  const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, job.companyId)).limit(1);
  const profile = await latestProfileFor(db, userId);
  const digest = await buildDigest(db, userId);
  const library = await latestCvLibrary(db, userId, { content: schema.cvLibraries.content });
  const role = {
    title: job.title,
    company: company?.name ?? "",
    ...scoreLocationInput(job),
    department: job.department ?? undefined,
    employmentType: job.employmentType ?? undefined,
    description: view.inTable ? job.descriptionText ?? undefined : undefined,
    keywordTerms: view.keywordTerms,
    locationTerms: settings.gate.locationTerms,
  };
  const route = resolveRoute(PROMPTS.A5, settings.stageRoutes);
  const model = routedModel(route, { callSite: modelForCallSite(settings, "A5") }, settings.defaultModel);
  const input = {
    profileMarkdown: profile?.markdown ?? settings.seedProfile ?? "",
    decisionDigest: digest,
    evidence: library ? scoringEvidence(scoringEvidenceBlocks(library.content),
      [role.title, role.department, ...(role.keywordTerms ?? []), role.description].filter(Boolean).join(" ")) : "",
    job: role,
    route: { model, effort: route.effort },
  };
  return { input, fingerprint: sha1(JSON.stringify([input, PROMPTS.A5.version])),
    profileVersion: profile?.version ?? null };
}

/**
 * Everything the score handler decides before it asks the model: whether the role is still open
 * and still this account's to score, whether the account has room, and — when the inputs are the
 * ones the stored score was computed from — that nothing needs asking. Each of those finishes the
 * work (`done`, with the task's result) and records on the view why it carries the score it
 * carries; otherwise the inputs come back `prepared`. Live scoring asks the model at once; batch
 * scoring puts the same request in a batch.
 */
export async function prepareScoreJob(deps: WorkerDeps, userId: string, jobId: string): Promise<{ done: unknown } | { prepared: PreparedScore }> {
  if (!userId) return { done: { skipped: "no account on task" } };
  const [job] = await deps.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job) return { done: { skipped: "job not found" } };
  if (job.status !== "open") {
    // Never scored, because the vacancy went before its turn came round — not "waiting".
    await markScoreState(deps, userId, jobId, "closed");
    return { done: { skipped: "job is closed" } };
  }
  const [view] = await deps.db.select().from(schema.userJobs).where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId))).limit(1);
  if (!view) return { done: { skipped: "role is not in this account's table" } };
  if (!job.shared && job.addedBy !== userId && !view.addedByUrl)
    return { done: { skipped: "role is no longer shared with this account" } };
  const settings = await loadUserSettings(deps.db, userId);
  const [choice] = await deps.db.select({ decision: schema.decisions.decision }).from(schema.decisions)
    .where(and(eq(schema.decisions.userId, userId), eq(schema.decisions.jobId, jobId), eq(schema.decisions.superseded, false))).limit(1);
  // A skipped or archived role's score has no reader: the table's order is for undecided roles,
  // and the score a decision is judged against was frozen when it was made. Undoing the skip
  // queues a score again (apps/web/lib/decisions.ts).
  if (view.archivedAt || choice?.decision === "skip") {
    await markScoreState(deps, userId, jobId, "decided");
    return { done: { skipped: "role is skipped or archived" } };
  }
  if (!view.inTable && choice?.decision !== "apply") {
    await markScoreState(deps, userId, jobId, "ineligible");
    return { done: { skipped: "role does not match and is not shortlisted" } };
  }
  const preparedAt = deps.now();
  // What the score was computed from. It is kept on this account's own view of the role, so an
  // unchanged rerun costs one row read rather than a row per (account, role) accumulating forever.
  const { input, fingerprint, profileVersion } = await scoreInputs(deps.db, userId, job, view, settings);
  if ((view.fitScore !== null || view.scoredAt !== null) && view.scoreInputHash === fingerprint) {
    // A stored fit, or a completed request with no usable fit, already covers these inputs.
    await markScoreState(deps, userId, jobId, "scored");
    return { done: { skipped: "scoring inputs unchanged" } };
  }
  // A submitted provider batch already owns precisely these inputs. The per-role task may have
  // been completed on hand-off, so a later admission can create another task; matching the batch
  // fingerprint avoids a second model call while still admitting a genuinely changed profile.
  const pendingBatch = await deps.db.execute(sql`select 1 from tasks t
    where t.type = 'poll_score_batch' and t.status in ('queued', 'running')
      and exists (select 1 from jsonb_array_elements(case
        when jsonb_typeof(t.payload->'items') = 'array' then t.payload->'items'
        else '[]'::jsonb end) item
        where item->>'userId' = ${userId} and item->>'jobId' = ${jobId}
          and item->>'fingerprint' = ${fingerprint}) limit 1`);
  if (pendingBatch.rows.length) return { done: { skipped: "score already in provider batch" } };
  // A matching stored score or submitted batch needs no new capacity. Only a new model request is
  // refused for an unavailable provider or an account whose spend and live holds filled its month.
  const scoreStop = await aiBudgetStop(deps, userId);
  if (scoreStop) {
    await markScoreState(deps, userId, jobId, scoreStop === "ai unavailable" ? "unavailable" : "budget");
    return { done: { skipped: scoreStop } };
  }
  const [attempt] = await deps.db.update(schema.userJobs)
    .set({ scoreAttemptVersion: sql`${schema.userJobs.scoreAttemptVersion} + 1` })
    .where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId)))
    .returning({ version: schema.userJobs.scoreAttemptVersion });
  if (!attempt) return { done: { skipped: "role is not in this account's table" } };
  return { prepared: { userId, jobId, input, fingerprint, profileVersion, preparedAt, attemptVersion: attempt.version } };
}

/** Recheck the exact request against the current role and account before publishing an AI answer. */
export async function checkScorePublication(deps: WorkerDeps, db: WorkerDeps["db"],
  score: Pick<PreparedScore, "userId" | "jobId" | "fingerprint" | "preparedAt"> & { attemptVersion?: number }): Promise<boolean> {
  const { userId, jobId } = score;
  await lockScoreModelInput(db, "shared");
  await lockAccountScoreInput(db, userId, "shared");
  // Lock global and account input fences first, then gate, company, job and view. New profile,
  // Library and decision rows have no stable row to lock; their writers take the account fence.
  await db.execute(sql`select user_id from user_settings where user_id = ${userId}::uuid and key = 'gate' for share`);
  const [jobRef] = await db.select({ companyId: schema.jobs.companyId }).from(schema.jobs)
    .where(eq(schema.jobs.id, jobId)).limit(1);
  if (!jobRef) return false;
  // Company deletion locks the company before cascading to its jobs. Match that order.
  const [company] = await db.select({ id: schema.companies.id }).from(schema.companies)
    .where(eq(schema.companies.id, jobRef.companyId)).for("share").limit(1);
  if (!company) return false;
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).for("share").limit(1);
  if (!job || job.companyId !== jobRef.companyId) return false;
  const [view] = await db.select().from(schema.userJobs)
    .where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId))).for("update").limit(1);
  if (!view) return false;
  const [choice] = await db.select({ decision: schema.decisions.decision }).from(schema.decisions)
    .where(and(eq(schema.decisions.userId, userId), eq(schema.decisions.jobId, jobId), eq(schema.decisions.superseded, false))).limit(1);
  const ineligible: ScoreState | null = job.status !== "open" ? "closed"
    : !job.shared && job.addedBy !== userId && !view.addedByUrl ? "ineligible"
    : view.archivedAt || choice?.decision === "skip" ? "decided"
    : !view.inTable && choice?.decision !== "apply" ? "ineligible" : null;
  if (ineligible) {
    await db.update(schema.userJobs).set({ scoreState: ineligible, scoreStateAt: deps.now() })
      .where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId)));
    return false;
  }
  const settings = await loadUserSettings(db, userId);
  const current = await scoreInputs(db, userId, job, view, settings);
  if (current.fingerprint !== score.fingerprint) {
    // A changed input needs durable work even when the original task is about to finish or the
    // provider batch has already taken ownership of it. A queued task with this key deduplicates.
    if (view.fitScore === null || view.scoreInputHash !== current.fingerprint) {
      await enqueueStandard(db, "score_job", { userId, jobId, live: true });
      await db.update(schema.userJobs).set({ scoreState: "queued", scoreStateAt: deps.now() })
        .where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId)));
    }
    return false;
  }
  if (score.attemptVersion === undefined || view.scoreAttemptVersion !== score.attemptVersion) {
    // Old persisted batches have no request number. They still settle their bill, but a fresh
    // request must own the view before an answer can be published.
    if (score.attemptVersion === undefined && (view.fitScore === null || view.scoreInputHash !== current.fingerprint)) {
      await enqueueStandard(db, "score_job", { userId, jobId, live: true });
      await db.update(schema.userJobs).set({ scoreState: "queued", scoreStateAt: deps.now() })
        .where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId)));
    }
    return false;
  }
  return true;
}

/**
 * The model was asked and gave nothing usable. The view says so beside its blank score, so a scan
 * does not queue the same inputs again every day; a changed profile or gate asks again.
 */
export async function markScoredWithoutResult(db: WorkerDeps["db"], now: Date,
  score: Pick<PreparedScore, "userId" | "jobId" | "fingerprint"> & { attemptVersion?: number }): Promise<boolean> {
  const written = await db.update(schema.userJobs).set({
    // A prior fit is retained for reference, but its attempted update has failed.
    scoreState: sql<ScoreState>`case when ${schema.userJobs.fitScore} is null then 'scored' else 'failed' end`,
    scoreInputHash: sql<string>`case when ${schema.userJobs.fitScore} is null then ${score.fingerprint} else ${schema.userJobs.scoreInputHash} end`,
    scoreStateAt: now, scoredAt: now,
  })
    .where(and(eq(schema.userJobs.userId, score.userId), eq(schema.userJobs.jobId, score.jobId),
      score.attemptVersion === undefined ? sql`false` : eq(schema.userJobs.scoreAttemptVersion, score.attemptVersion)))
    .returning({ jobId: schema.userJobs.jobId });
  return written.length > 0;
}

/**
 * Store one score on this account's view of the role, with the `scored` event. It writes the fit
 * fields and the score's bookkeeping and nothing else: never `in_table`, which the gate alone
 * decides, so a score — however late it lands — changes the table's order, never what is in it.
 *
 * A score arriving late is written only while its prepared attempt still owns this view.
 * Returns whether it was written.
 */
export async function writeScore(
  db: WorkerDeps["db"],
  now: Date,
  score: Pick<PreparedScore, "userId" | "jobId" | "fingerprint" | "profileVersion"> & { attemptVersion?: number },
  result: ScoreJobResult,
): Promise<boolean> {
  const fresher = score.attemptVersion === undefined ? sql`false` : eq(schema.userJobs.scoreAttemptVersion, score.attemptVersion);
  const written = await db
    .update(schema.userJobs)
    .set({
      fitScore: result.score,
      fitVerdict: result.verdict,
      fitRationale: result.rationale,
      fitProfileVersion: score.profileVersion,
      fitScoredAt: now,
      scoreInputHash: score.fingerprint,
      scoreState: "scored",
      scoreStateAt: now,
      scoredAt: now,
      updatedAt: now,
    })
    .where(and(eq(schema.userJobs.userId, score.userId), eq(schema.userJobs.jobId, score.jobId), fresher))
    .returning({ jobId: schema.userJobs.jobId });
  if (!written.length) return false;
  await db.insert(schema.jobEvents).values({ jobId: score.jobId, userId: score.userId, type: "scored", payload: { score: result.score, verdict: result.verdict } });
  return true;
}

/** A score that could not be asked for because this key cannot reach the model; the task retries. */
export class ModelAccessError extends Error {
  constructor(readonly failure: AiFailure) {
    super(`A5 model unreachable with this key${failure.status ? ` (HTTP ${failure.status})` : ""}; the role stays unscored and the task retries`);
    this.name = "ModelAccessError";
  }
}

export async function handleScoreJob(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { userId, jobId } = task.payload as unknown as TaskPayloads["score_job"];
  const prep = await prepareScoreJob(deps, userId, jobId);
  if ("done" in prep) return prep.done;
  const { input } = prep.prepared;
  let failure: AiFailure | undefined;
  const result = await withinAccountBudget(deps.ai.scoreJob(input,
    { refType: "job", refId: jobId, userId, signal: deps.signal, onFailure: failed => { failure = failed; } },
  ));
  if (result === ACCOUNT_BUDGET_REFUSED) {
    await markScoreState(deps, userId, jobId, "budget");
    return BUDGET_SKIP;
  }
  // The key could not reach the model: nothing was asked, so the role is not "scored without a
  // result", which a scan would never queue again. It stays unscored and the task retries.
  if (!result && failure?.kind === "model_access") throw new ModelAccessError(failure);
  if (!result) {
    return deps.db.transaction(async tx => {
      const writer = tx as unknown as WorkerDeps["db"];
      await deps.assertOwnership?.(writer);
      if (!await checkScorePublication(deps, writer, prep.prepared)) return { skipped: "score result no longer current" };
      return await markScoredWithoutResult(writer, deps.now(), prep.prepared)
        ? { skipped: "no ai result" } : { skipped: "newer score already landed" };
    });
  }

  return deps.db.transaction(async tx => {
    const writer = tx as unknown as WorkerDeps["db"];
    await deps.assertOwnership?.(writer);
    if (!await checkScorePublication(deps, writer, prep.prepared)) return { skipped: "score result no longer current" };
    return await writeScore(writer, deps.now(), prep.prepared, result)
      ? { score: result.score, verdict: result.verdict } : { skipped: "newer score already landed" };
  });
}

/**
 * A library as the blocks scoring may be shown: only evidence the person has confirmed, each block
 * under the heading a reader knows it by, with its rows and skills once each.
 */
function scoringEvidenceBlocks(library: CvLibrary): ScoringEvidenceBlock[] {
  const blocks: ScoringEvidenceBlock[] = [];
  if (library.profile.trim()) blocks.push({ heading: "Profile", rows: [library.profile.trim()] });
  for (const entry of library.entries) {
    const eligible = eligibleCvEvidence(entry);
    if (!eligible) continue;
    const rows = eligible.kind === "experience" ? eligible.confirmedResponsibilities ?? [] : responsibilityRows(eligible.details);
    blocks.push({
      heading: `${evidenceHeading(library, eligible)} (${eligible.kind})`,
      rows: [...rows, ...(eligible.skillItems?.length ? [`Skills: ${eligible.skillItems.join(", ")}`] : [])],
    });
  }
  return blocks;
}

export async function latestProfile(deps: WorkerDeps, userId: string) {
  return latestProfileFor(deps.db, userId);
}

async function decisionRows(db: WorkerDeps["db"], userId: string, limit = 200) {
  return db
    .select()
    .from(schema.decisions)
    .where(and(eq(schema.decisions.userId, userId), eq(schema.decisions.superseded, false)))
    .orderBy(desc(schema.decisions.createdAt))
    .limit(limit);
}

async function buildDigest(db: WorkerDeps["db"], userId: string): Promise<string> {
  const rows = await decisionRows(db, userId, 100);
  return decisionDigest(
    rows.map((d) => ({
      title: d.jobTitle,
      company: d.companyName,
      location: d.jobLocation ?? undefined,
      department: d.jobDepartment ?? undefined,
      decision: d.decision,
      reason: d.reason,
      tags: d.tags,
      snippet: d.descriptionSnippet ?? undefined,
      fitScore: d.fitScoreAtDecision,
      at: d.createdAt.toISOString(),
    })),
    { maxItems: 100, maxChars: 12_000 },
  );
}

const RESYNTHESIS_THRESHOLD = 5;

/** How many outcomes reach one synthesis. Newest first, so a long history keeps its recent half. */
const OUTCOME_LIMIT = 50;

/**
 * Where this account's applications actually ended up: the newest row per role, kept to the two
 * statuses that are outcomes rather than progress.
 *
 * The synthesiser reads decisions, which are what someone hoped for at the moment they looked at a
 * role. An acceptance is what they chose in the end and a rejection is evidence about fit, so the
 * two are given to it apart from the decisions rather than mixed in among them.
 */
async function accountOutcomes(deps: WorkerDeps, userId: string) {
  const latest = latestApplicationFor(userId);
  const rows = await deps.db
    .select({
      title: schema.applications.jobTitle,
      company: schema.applications.companyName,
      status: latest.status,
      appliedOn: latest.appliedOn,
      at: latest.createdAt,
    })
    .from(latest)
    .innerJoin(schema.applications, eq(schema.applications.id, latest.id))
    .where(inArray(latest.status, ["accepted", "rejected"]))
    .orderBy(desc(latest.createdAt))
    .limit(OUTCOME_LIMIT);
  return rows.map(({ at: _at, ...row }) => row);
}

export async function handleSynthesizeProfile(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { userId, force } = (task.payload ?? {}) as TaskPayloads["synthesize_profile"];
  if (!userId) return { skipped: "no account on task" };
  const profileStop = await aiBudgetStop(deps, userId);
  if (profileStop) return { skipped: profileStop };
  const settings = await deps.userSettings(userId);
  const current = await latestProfile(deps, userId);
  const counts = await decisionCounts(deps, userId, current?.generatedAt ?? null);
  if (counts.total === 0 && !settings.seedProfile.trim()) return { skipped: "nothing to synthesise from" };
  const since = current ? counts.since : counts.total;
  if (!force && current && since < RESYNTHESIS_THRESHOLD) return { skipped: `only ${since} new decisions` };
  // The newest decisions are the prompt's; the count above is over every one of them.
  const decisions = await decisionRows(deps.db, userId, 500);

  const disagreements = decisions
    .filter((d) => d.fitScoreAtDecision !== null && ((d.fitScoreAtDecision >= 70 && d.decision === "skip") || (d.fitScoreAtDecision < 30 && d.decision === "apply")))
    .slice(0, 20)
    .map((d) => ({ title: d.jobTitle, company: d.companyName, decision: d.decision, fitScore: d.fitScoreAtDecision ?? 0, reason: d.reason }));

  const rejected = await deps.db
    .select({ name: schema.companySuggestions.name, reason: schema.companySuggestions.rejectionReason })
    .from(schema.companySuggestions)
    .where(and(eq(schema.companySuggestions.userId, userId), eq(schema.companySuggestions.status, "rejected")))
    .limit(30);

  const outcomes = await accountOutcomes(deps, userId);

  const result = await withinAccountBudget(deps.ai.synthesizeProfile({
    seedProfile: settings.seedProfile,
    pinnedStatements: current?.pinnedStatements ?? [],
    currentProfile: current?.markdown,
    decisions: decisions.map((d) => ({
      title: d.jobTitle,
      company: d.companyName,
      location: d.jobLocation ?? undefined,
      department: d.jobDepartment ?? undefined,
      decision: d.decision,
      reason: d.reason,
      tags: d.tags,
      snippet: d.descriptionSnippet ?? undefined,
      fitScore: d.fitScoreAtDecision,
      at: d.createdAt.toISOString(),
    })),
    disagreements,
    rejectedCompanySuggestions: rejected.filter((r) => r.reason).map((r) => ({ name: r.name, reason: r.reason ?? "" })),
    outcomes,
  }, { refType: "profile", refId: userId, userId, signal: deps.signal }));
  if (result === ACCOUNT_BUDGET_REFUSED) return BUDGET_SKIP;
  if (!result) return { skipped: "no ai result" };

  const version = (current?.version ?? 0) + 1;
  const openQuestions = result.openQuestions.map((q) => ({ id: q.id, question: q.question }));
  // A profile that reads as it did scores every role as it did: no rescore for a tag edit or an
  // undo that moved nothing.
  const changed = result.markdown !== current?.markdown;
  // Behind the task's fence: a run the queue has given up on must not write a version, or queue a
  // rescore, after its retry has already started.
  await deps.db.transaction(async tx => {
    await deps.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
    await appendProfile(tx as unknown as WorkerDeps["db"], userId, current?.version ?? 0, {
      markdown: result.markdown,
      pinnedStatements: current?.pinnedStatements ?? [],
      openQuestions,
      sourceDecisionCount: counts.total,
      model: modelForCallSite(settings, "A7"),
      generatedAt: deps.now(),
    });
    if (changed) await enqueueStandard(tx, "rescore_all", { userId, onlyInTable: true });
  });
  log.info("profile synthesised", { userId, version, decisions: counts.total, questions: openQuestions.length, changed });
  return { version, decisions: counts.total };
}

/**
 * How many decisions this account has in force, and how many of them were made since `after`
 * (the last profile version): new ones, and changed ones, since changing a decision supersedes the
 * old row and writes a new one. Counted, not read: an account past 500 decisions still counts.
 */
async function decisionCounts(deps: WorkerDeps, userId: string, after: Date | null): Promise<{ total: number; since: number }> {
  const rows = await deps.db.execute<{ total: number; since: number }>(sql`select count(*)::int as total,
    count(*) filter (where ${after === null ? sql`true` : sql`${schema.decisions.createdAt} > ${after}`})::int as since
    from ${schema.decisions} where ${schema.decisions.userId} = ${userId} and ${schema.decisions.superseded} = false`);
  return { total: Number(rows.rows[0]?.total ?? 0), since: Number(rows.rows[0]?.since ?? 0) };
}

/**
 * How long a rejected suggestion stays rejected (R-6.9).
 *
 * Rejecting a term means "not now", not "never": the gate that made it wrong two months ago may
 * have moved, and until this existed a single rejection stood for the life of the account. After
 * the window the term may be proposed again — which is a proposal, not a change: accepting one is
 * still the person's.
 */
export const REJECTED_SUGGESTION_TTL_MS = 60 * 86_400_000;

/** A rejection this recent still counts as taken; anything older has expired. */
export function rejectionCutoff(now: Date): Date {
  return new Date(now.getTime() - REJECTED_SUGGESTION_TTL_MS);
}

export async function handleSuggestFilters(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { userId } = (task.payload ?? {}) as TaskPayloads["suggest_filters"];
  if (!userId) return { skipped: "no account on task" };
  const filterStop = await aiBudgetStop(deps, userId);
  if (filterStop) return { skipped: filterStop };
  const settings = await deps.userSettings(userId);
  const decisions = await decisionRows(deps.db, userId, 300);
  if (decisions.length === 0) return { skipped: "no decisions" };

  // A rejection older than its window is no longer evidence of anything: the term is not named as
  // off-limits, and the duplicate check below lets it be filed again.
  const cutoff = rejectionCutoff(deps.now());
  const liveRejection = sql`coalesce(${schema.filterSuggestions.resolvedAt}, ${schema.filterSuggestions.createdAt}) >= ${cutoff}`;
  const previouslyRejected = await deps.db
    .select({ type: schema.filterSuggestions.type, value: schema.filterSuggestions.value })
    .from(schema.filterSuggestions)
    .where(and(eq(schema.filterSuggestions.userId, userId), eq(schema.filterSuggestions.status, "rejected"), liveRejection));

  const map = (d: (typeof decisions)[number]) => ({
    title: d.jobTitle,
    company: d.companyName,
    location: d.jobLocation ?? undefined,
    department: d.jobDepartment ?? undefined,
    decision: d.decision,
    reason: d.reason,
    tags: d.tags,
    snippet: d.descriptionSnippet ?? undefined,
    fitScore: d.fitScoreAtDecision,
    at: d.createdAt.toISOString(),
  });

  // The companies a pause may name: the ones this account follows and has not already paused.
  const companies = await deps.db.select({ id: schema.companies.id, name: schema.companies.name })
    .from(schema.companySubscriptions)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.companySubscriptions.companyId))
    .where(and(eq(schema.companySubscriptions.userId, userId), eq(schema.companySubscriptions.status, "active")))
    .orderBy(schema.companies.name);

  const result = await withinAccountBudget(deps.ai.suggestFilters({
    includeKeywords: settings.gate.includeKeywords,
    excludeKeywords: settings.gate.excludeKeywords,
    locationTerms: settings.gate.locationTerms,
    decisions: decisions.map(map),
    previouslyRejected: previouslyRejected.map((r) => ({ type: r.type, value: r.value })),
    companies,
  }, { refType: "filters", refId: userId, userId, signal: deps.signal }));
  if (result === ACCOUNT_BUDGET_REFUSED) return BUDGET_SKIP;
  if (!result) return { skipped: "no ai result" };

  // Behind the task's fence, so a run the queue has given up on files nothing after its retry began.
  return deps.db.transaction(async tx => {
    await deps.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
    let inserted = 0;
    for (const s of result) {
      // Compared by what the suggestion names, not by its whole value: one the scans filed carries
      // a `source` beside its term, and the same term in another case is the same term.
      const names = s.type === "pause_company"
        ? sql`${schema.filterSuggestions.value}->>'companyId' = ${String(s.value.companyId)}`
        : sql`lower(${schema.filterSuggestions.value}->>'term') = ${String(s.value.term).toLowerCase()}`;
      const duplicate = await tx
        .select({ id: schema.filterSuggestions.id })
        .from(schema.filterSuggestions)
        .where(and(eq(schema.filterSuggestions.userId, userId), eq(schema.filterSuggestions.type, s.type), names,
          sql`(${schema.filterSuggestions.status} = 'pending' or (${schema.filterSuggestions.status} = 'rejected' and ${liveRejection}))`))
        .limit(1);
      if (duplicate.length) continue;
      await tx.insert(schema.filterSuggestions).values({ userId, type: s.type, value: s.value, evidence: s.evidence, rationale: s.rationale });
      inserted++;
    }
    return { suggestions: inserted };
  });
}

/** How many of an account's views a gate re-evaluation wrote: created, changed or archived. */
function gateWrites(outcome: unknown): number {
  const o = (outcome ?? {}) as { created?: number; changed?: number; archived?: number };
  return (o.created ?? 0) + (o.changed ?? 0) + (o.archived ?? 0);
}

/** Re-evaluate the keyword and location gate for one account, or every account, after a settings change. */
/**
 * Re-run one account's gate, or every account's when the task names none.
 *
 * The lease is keyed per account, so one account's re-evaluation never makes another's wait or
 * fail busy: the boot task and settings saves enqueue one task per account and they run in
 * parallel across the queue's slots. A task that does name an account takes only that account's
 * lease.
 */
export async function handleReevaluateGate(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { userId, companyId } = (task.payload ?? {}) as TaskPayloads["reevaluate_gate"];
  // This account's settings when the task names one; every account's only for the all-accounts run.
  deps.invalidateSettings(userId);
  const users = userId ? [userId] : await listUserIds(deps.db);
  const outcomes: Record<string, unknown> = {};
  let written = 0;
  for (const id of users) {
    const outcome = await withResourceLease(deps, `reevaluate-gate:${id}`, async locked => {
      const settings = await deps.userSettings(id);
      return deps.db.transaction(async tx => {
        await locked.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
        return reevaluateGate(tx as unknown as WorkerDeps["db"], id, settings, deps.now(), { companyId }, {
          scoreCandidates: async (writer, pairs) => (await admitScores(deps, pairs, {
            db: writer, onlyUnscored: true, settings: new Map([[id, settings]]),
          })).queued,
        });
      });
    });
    outcomes[id] = outcome;
    written += gateWrites(outcome);
  }
  // Hundreds of views rewritten at once leave the planner's picture of `user_jobs` behind; refresh
  // it after the transactions have committed, not inside them.
  const analysed = written > GATE_ANALYZE_THRESHOLD ? await analyzeTables(deps.db, GATE_TABLES, "reevaluate_gate") : false;
  return { accounts: users.length, outcomes, ...(analysed ? { analysed: true } : {}) };
}

/**
 * How often one account's roles may all be re-scored. A Library save, a settings save and every
 * profile version each asked for a full pass, one A5 call per open role, so an editing session
 * paid for the same table several times over.
 */
export const RESCORE_INTERVAL_MS = 60 * 60_000;

/** What a full re-score is computed from for one account: its profile, gate, scoring model and evidence. */
async function rescoreInputs(deps: WorkerDeps, userId: string): Promise<string> {
  const settings = await loadUserSettings(deps.db, userId);
  const profile = await latestProfileFor(deps.db, userId);
  const library = await latestCvLibrary(deps.db, userId, { content: schema.cvLibraries.content });
  const digest = await buildDigest(deps.db, userId);
  const route = resolveRoute(PROMPTS.A5, settings.stageRoutes);
  const model = routedModel(route, { callSite: modelForCallSite(settings, "A5") }, settings.defaultModel);
  const companies = await deps.db.execute<{ id: string; name: string }>(sql`select distinct c.id, c.name
    from companies c join jobs j on j.company_id = c.id
    join user_jobs uj on uj.job_id = j.id
    where uj.user_id = ${userId}::uuid order by c.id`);
  return sha1(JSON.stringify([
    profile?.markdown ?? settings.seedProfile ?? "",
    settings.gate,
    digest,
    PROMPTS.A5.version, model, route.effort,
    companies.rows,
    library ? scoringEvidenceBlocks(library.content) : [],
  ]));
}

export async function handleRescoreAll(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { userId, onlyInTable } = (task.payload ?? {}) as TaskPayloads["rescore_all"];
  if (!userId) return { skipped: "no account on task" };
  const inputsHash = await rescoreInputs(deps, userId);
  // The last full pass this account actually ran: when it finished, and what it scored from.
  const [last] = await deps.db.select({ finishedAt: schema.tasks.finishedAt, result: schema.tasks.result }).from(schema.tasks)
    .where(and(eq(schema.tasks.type, "rescore_all"), eq(schema.tasks.status, "done"),
      sql`${schema.tasks.payload}->>'userId' = ${userId}`, sql`${schema.tasks.result} ? 'queued'`))
    .orderBy(desc(schema.tasks.finishedAt)).limit(1);
  const sameInputs = !!last && (last.result as { inputsHash?: string } | null)?.inputsHash === inputsHash;
  const retryable = sameInputs ? await deps.db.execute(sql`select 1 from user_jobs uj join jobs j on j.id = uj.job_id
    where uj.user_id = ${userId}::uuid and j.status = 'open' and uj.archived_at is null
      and uj.score_state in ('unavailable', 'budget', 'failed')
      and (uj.in_table or exists (select 1 from decisions d where d.user_id = uj.user_id and d.job_id = uj.job_id
        and d.superseded = false and d.decision = 'apply'))
      and not exists (select 1 from decisions d where d.user_id = uj.user_id and d.job_id = uj.job_id
        and d.superseded = false and d.decision = 'skip')
      and not exists (select 1 from tasks t where t.type = 'score_job' and t.status in ('queued', 'running')
        and t.payload->>'userId' = uj.user_id::text and t.payload->>'jobId' = uj.job_id::text)
    limit 1`) : null;
  const retryOnly = !!retryable?.rows.length;
  if (sameInputs && !retryOnly) return { skipped: "scoring inputs unchanged since the last rescore" };
  if (!retryOnly && last?.finishedAt && deps.now().getTime() - last.finishedAt.getTime() < RESCORE_INTERVAL_MS) {
    // Coalesced: one pass at the end of the hour picks up everything that changed within it, and
    // any other save in the hour folds into the same waiting row by its key.
    const retryAt = new Date(last.finishedAt.getTime() + RESCORE_INTERVAL_MS);
    await enqueueStandard(deps.db, "rescore_all", { userId, onlyInTable: onlyInTable ?? true }, { runAfter: retryAt });
    return { skipped: "rescored within the hour", retryAt: retryAt.toISOString() };
  }
  const shortlisted = sql<boolean>`exists (select 1 from decisions d where d.user_id = ${schema.userJobs.userId} and d.job_id = ${schema.userJobs.jobId} and d.superseded = false and d.decision = 'apply')`;
  // Skipped and archived roles are left out: their score has no reader (see `prepareScoreJob`).
  const skipped = sql<boolean>`exists (select 1 from decisions d where d.user_id = ${schema.userJobs.userId} and d.job_id = ${schema.userJobs.jobId} and d.superseded = false and d.decision = 'skip')`;
  const rows = await deps.db.select({ id: schema.userJobs.jobId, shortlisted }).from(schema.userJobs)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.userJobs.jobId))
    .where(and(eq(schema.userJobs.userId, userId), eq(schema.jobs.status, "open"), isNull(schema.userJobs.archivedAt),
      sql`not ${skipped}`, sql`(${schema.userJobs.inTable} or ${shortlisted})`,
      sql`(${!retryOnly} or ${schema.userJobs.scoreState} in ('unavailable', 'budget', 'failed'))`)).orderBy(desc(shortlisted));
  // A shortlisted role's score is the one the person is waiting on: a background score already
  // queued for it is brought up to that priority rather than left where it was, and scored live.
  // The rest only reorder a table the person has already seen, so they are marked background and
  // go through the batch collector at half price even while scoring is live. Every role a new
  // profile version will re-score reads "scoring" until its turn comes.
  let queued = 0;
  let unavailable = 0;
  let budget = 0;
  for (const [shortlistedRows, options] of [
    [rows.filter(row => row.shortlisted), { priority: 1 }],
    [rows.filter(row => !row.shortlisted), { background: true }],
  ] as const) {
    for (let offset = 0; offset < shortlistedRows.length; offset += 250) {
      const admitted = await admitScores(deps, shortlistedRows.slice(offset, offset + 250).map(row => ({ userId, jobId: row.id })), options);
      queued += admitted.queued;
      unavailable += admitted.blockedUnavailable;
      budget += admitted.blockedBudget;
    }
  }
  // A pass that could not create model work has not rescored these inputs. Omitting `queued` keeps
  // the next request eligible when an operator configures AI or the account's budget resets.
  if (!queued && (unavailable || budget)) return { skipped: unavailable ? "ai unavailable" : "account ai budget exceeded", unavailable, budget, inputsHash };
  return { queued, inputsHash };
}
