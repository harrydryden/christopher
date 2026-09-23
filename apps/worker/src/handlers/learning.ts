import { withResourceLease } from "../lease";
import { schema, enqueueTask, latestApplicationFor, reevaluateGate, appendProfile, latestProfileFor, listUserIds, seedTagVocabulary, type ScoreState, type Task } from "@ava/db";
import { decisionDigest } from "@ava/ai";
import { eligibleCvEvidence, evidenceHeading, responsibilityRows, scoringEvidence, sha1, dedupeKeyFor, modelForCallSite, priorityFor, type CvLibrary, type ScoringEvidenceBlock, type TaskPayloads } from "@ava/core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { WorkerDeps } from "../context";
import { aiBudgetStop } from "../context";
import { isAccountBudgetRefusal } from "../budget";
import { log } from "../log";

/** What a handler finishes with when its account has no room left for the call it was about to make. */
const BUDGET_SKIP = { skipped: "account ai budget exceeded" } as const;
const REFUSED = Symbol("refused by the account's budget");

/**
 * A model call whose hold the account's own budget may refuse. The pre-check (`aiBudgetStop`)
 * catches an account with nothing left; this catches one with too little left for this call, so
 * the task finishes done and skipped instead of failing, retrying and failing again. Any other
 * refusal — a deployment cap — is still thrown, and backs off as a failure does.
 */
async function withinBudget<T>(call: Promise<T>): Promise<T | typeof REFUSED> {
  try {
    return await call;
  } catch (err) {
    if (isAccountBudgetRefusal(err)) return REFUSED;
    throw err;
  }
}

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
  const result = await withinBudget(deps.ai.tagReason(
    {
      reason: decision.reason,
      decision: decision.decision,
      job: { title: decision.jobTitle, company: decision.companyName, location: decision.jobLocation ?? undefined, department: decision.jobDepartment ?? undefined },
      vocabulary: vocab.map((v) => v.tag),
    },
    { refType: "decision", refId: decision.id, userId: decision.userId },
  ));
  if (result === REFUSED) return BUDGET_SKIP;
  if (!result) return { skipped: "no ai result" };

  await deps.db.update(schema.decisions).set({ tags: result.tags }).where(and(eq(schema.decisions.id, decision.id), eq(schema.decisions.tagsEdited, false), eq(schema.decisions.superseded, false)));
  if (result.proposedNewTags.length) {
    await deps.db
      .insert(schema.tagVocabulary)
      .values(result.proposedNewTags.map((t) => ({ userId: decision.userId, tag: t.tag, description: t.description, createdBy: "model" as const, accepted: false })))
      .onConflictDoNothing();
  }
  return { tags: result.tags, proposed: result.proposedNewTags.length };
}

/**
 * Why this account's view of a role carries the score it carries, recorded where the table reads
 * it. A blank score covered five situations and the row could not say which; every outcome of
 * this handler now names its own. Silent when the account has no view of the role: there is no
 * row to say it on, which is itself the `ineligible` case.
 */
async function markScoreState(deps: WorkerDeps, userId: string, jobId: string, state: ScoreState) {
  await deps.db.update(schema.userJobs).set({ scoreState: state, scoreStateAt: deps.now() })
    .where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId),
      sql`${schema.userJobs.scoreState} is distinct from ${state}`));
}

export async function handleScoreJob(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { userId, jobId } = task.payload as unknown as TaskPayloads["score_job"];
  if (!userId) return { skipped: "no account on task" };
  const [job] = await deps.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job) return { skipped: "job not found" };
  if (job.status !== "open") {
    // Never scored, because the vacancy went before its turn came round — not "waiting".
    await markScoreState(deps, userId, jobId, "closed");
    return { skipped: "job is closed" };
  }
  const [view] = await deps.db.select().from(schema.userJobs).where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId))).limit(1);
  if (!view) return { skipped: "role is not in this account's table" };
  const settings = await deps.userSettings(userId);
  const [choice] = await deps.db.select({ decision: schema.decisions.decision }).from(schema.decisions)
    .where(and(eq(schema.decisions.userId, userId), eq(schema.decisions.jobId, jobId), eq(schema.decisions.superseded, false))).limit(1);
  if (!view.inTable && choice?.decision !== "apply") {
    await markScoreState(deps, userId, jobId, "ineligible");
    return { skipped: "role does not match and is not shortlisted" };
  }
  // Asked before any of the scoring evidence is gathered: an account with nothing left to spend
  // skips this role, and the task finishes done rather than failing at the hold and retrying.
  const scoreStop = await aiBudgetStop(deps, userId);
  if (scoreStop) {
    await markScoreState(deps, userId, jobId, "budget");
    return { skipped: scoreStop };
  }

  const [company] = await deps.db.select().from(schema.companies).where(eq(schema.companies.id, job.companyId)).limit(1);
  const profile = await latestProfileFor(deps.db, userId);
  const digest = await buildDigest(deps, userId);

  const [library] = await deps.db.select({ content: schema.cvLibraries.content }).from(schema.cvLibraries)
    .where(eq(schema.cvLibraries.userId, userId)).orderBy(desc(schema.cvLibraries.version)).limit(1);
  const role = {
    title: job.title,
    company: company?.name ?? "",
    location: job.location ?? undefined,
    department: job.department ?? undefined,
    employmentType: job.employmentType ?? undefined,
    // Near-miss candidates are scored on metadata only (no description fetch for roles outside the gate).
    description: view.inTable ? job.descriptionText ?? undefined : undefined,
    keywordTerms: view.keywordTerms,
  };
  const input = {
    profileMarkdown: profile?.markdown ?? settings.seedProfile ?? "",
    decisionDigest: digest,
    // The confirmed evidence that bears on this role, bounded: never the whole library.
    evidence: library ? scoringEvidence(scoringEvidenceBlocks(library.content),
      [role.title, role.department, ...(role.keywordTerms ?? []), role.description].filter(Boolean).join(" ")) : "",
    job: role,
  };
  // What the score was computed from. It is kept on this account's own view of the role, so an
  // unchanged rerun costs one row read rather than a row per (account, role) accumulating forever.
  const fingerprint = sha1(JSON.stringify([input, modelForCallSite(settings, "A5")]));
  if (view.fitScore !== null && view.scoreInputHash === fingerprint) {
    // The stored score still stands, so the row is scored: say so, which also repairs a row that
    // predates the column and one queued by a scan that found nothing to re-read.
    await markScoreState(deps, userId, jobId, "scored");
    return { skipped: "scoring inputs unchanged" };
  }
  const result = await withinBudget(deps.ai.scoreJob(input,
    { refType: "job", refId: job.id, userId },
  ));
  if (result === REFUSED) {
    await markScoreState(deps, userId, jobId, "budget");
    return BUDGET_SKIP;
  }
  if (!result) return { skipped: "no ai result" };

  return deps.db.transaction(async tx => {
    await deps.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
  await tx
    .update(schema.userJobs)
    .set({
      fitScore: result.score,
      fitVerdict: result.verdict,
      fitRationale: result.rationale,
      fitProfileVersion: profile?.version ?? null,
      fitScoredAt: deps.now(),
      scoreInputHash: fingerprint,
      scoreState: "scored",
      scoreStateAt: deps.now(),
      hidden: false,
      updatedAt: deps.now(),
    })
    .where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, job.id)));
  await tx.insert(schema.jobEvents).values({ jobId: job.id, userId, type: "scored", payload: { score: result.score, verdict: result.verdict } });
  return { score: result.score, verdict: result.verdict };
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

async function decisionRows(deps: WorkerDeps, userId: string, limit = 200) {
  return deps.db
    .select()
    .from(schema.decisions)
    .where(and(eq(schema.decisions.userId, userId), eq(schema.decisions.superseded, false)))
    .orderBy(desc(schema.decisions.createdAt))
    .limit(limit);
}

async function buildDigest(deps: WorkerDeps, userId: string): Promise<string> {
  const rows = await decisionRows(deps, userId, 100);
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
  const decisions = await decisionRows(deps, userId, 500);
  if (decisions.length === 0 && !settings.seedProfile.trim()) return { skipped: "nothing to synthesise from" };
  const since = current ? decisions.length - current.sourceDecisionCount : decisions.length;
  if (!force && current && since < RESYNTHESIS_THRESHOLD) return { skipped: `only ${since} new decisions` };

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

  const result = await withinBudget(deps.ai.synthesizeProfile({
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
  }, { refType: "profile", refId: userId, userId }));
  if (result === REFUSED) return BUDGET_SKIP;
  if (!result) return { skipped: "no ai result" };

  const version = (current?.version ?? 0) + 1;
  const openQuestions = result.openQuestions.map((q) => ({ id: q.id, question: q.question }));
  await appendProfile(deps.db, userId, current?.version ?? 0, {
    markdown: result.markdown,
    pinnedStatements: current?.pinnedStatements ?? [],
    openQuestions,
    sourceDecisionCount: decisions.length,
    model: modelForCallSite(settings, "A7"),
    generatedAt: deps.now(),
  });
  log.info("profile synthesised", { userId, version, decisions: decisions.length, questions: openQuestions.length });

  const p = { userId, onlyInTable: true };
  await enqueueTask(deps.db, "rescore_all", p, { dedupeKey: dedupeKeyFor("rescore_all", p), priority: priorityFor("rescore_all") });
  return { version, decisions: decisions.length };
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
  const decisions = await decisionRows(deps, userId, 300);
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

  const result = await withinBudget(deps.ai.suggestFilters({
    includeKeywords: settings.gate.includeKeywords,
    excludeKeywords: settings.gate.excludeKeywords,
    locationTerms: settings.gate.locationTerms,
    decisions: decisions.map(map),
    previouslyRejected: previouslyRejected.map((r) => ({ type: r.type, value: r.value })),
  }, { refType: "filters", refId: userId, userId }));
  if (result === REFUSED) return BUDGET_SKIP;
  if (!result) return { skipped: "no ai result" };

  let inserted = 0;
  for (const s of result) {
    const duplicate = await deps.db
      .select({ id: schema.filterSuggestions.id })
      .from(schema.filterSuggestions)
      .where(and(eq(schema.filterSuggestions.userId, userId), eq(schema.filterSuggestions.type, s.type), // Compared as jsonb, not as text: `{"term":"x"}::text` renders with a space after the
        // colon, so a text comparison against compact JSON never matched and every duplicate was
        // filed again.
        sql`${schema.filterSuggestions.value} = ${JSON.stringify(s.value)}::jsonb`,
        sql`(${schema.filterSuggestions.status} = 'pending' or (${schema.filterSuggestions.status} = 'rejected' and ${liveRejection}))`))
      .limit(1);
    if (duplicate.length) continue;
    await deps.db.insert(schema.filterSuggestions).values({ userId, type: s.type, value: s.value, evidence: s.evidence, rationale: s.rationale });
    inserted++;
  }
  return { suggestions: inserted };
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
  deps.invalidateSettings();
  const users = userId ? [userId] : await listUserIds(deps.db);
  const outcomes: Record<string, unknown> = {};
  for (const id of users) {
    outcomes[id] = await withResourceLease(deps, `reevaluate-gate:${id}`, async locked => {
      const settings = await deps.userSettings(id);
      return deps.db.transaction(async tx => {
        await locked.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
        return reevaluateGate(tx as unknown as WorkerDeps["db"], id, settings, deps.now(), { companyId });
      });
    });
  }
  return { accounts: users.length, outcomes };
}

export async function handleRescoreAll(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { userId } = (task.payload ?? {}) as TaskPayloads["rescore_all"];
  if (!userId) return { skipped: "no account on task" };
  const shortlisted = sql<boolean>`exists (select 1 from decisions d where d.user_id = ${schema.userJobs.userId} and d.job_id = ${schema.userJobs.jobId} and d.superseded = false and d.decision = 'apply')`;
  const rows = await deps.db.select({ id: schema.userJobs.jobId, shortlisted }).from(schema.userJobs)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.userJobs.jobId))
    .where(and(eq(schema.userJobs.userId, userId), eq(schema.jobs.status, "open"), sql`(${schema.userJobs.inTable} or ${shortlisted})`)).orderBy(desc(shortlisted));
  let queued = 0;
  for (let offset = 0; offset < rows.length; offset += 250) {
    const batch = rows.slice(offset, offset + 250);
    const values = batch.map(row => {
      const payload = { userId, jobId: row.id };
      return { type: 'score_job' as const, payload, dedupeKey: dedupeKeyFor('score_job', payload), priority: row.shortlisted ? 1 : priorityFor('score_job') };
    });
    const inserted = await deps.db.insert(schema.tasks).values(values).onConflictDoNothing().returning({ id: schema.tasks.id });
    queued += inserted.length;
    // Every role a new profile version will re-score reads "scoring" until its turn comes.
    await deps.db.update(schema.userJobs).set({ scoreState: "queued", scoreStateAt: deps.now() })
      .where(and(eq(schema.userJobs.userId, userId), inArray(schema.userJobs.jobId, batch.map(row => row.id))));
  }
  return { queued };
}
