import { withResourceLease } from "../lease";
import { schema, enqueueTask, reevaluateGate, appendProfile, latestProfileFor, listUserIds, seedTagVocabulary, type Task } from "@christopher/db";
import { decisionDigest } from "@christopher/ai";
import { eligibleCvEvidence, evidenceHeading, sha1, dedupeKeyFor, modelForCallSite, priorityFor, type TaskPayloads } from "@christopher/core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { WorkerDeps } from "../context";
import { aiBudgetStop } from "../context";
import { log } from "../log";

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
  const result = await deps.ai.tagReason(
    {
      reason: decision.reason,
      decision: decision.decision,
      job: { title: decision.jobTitle, company: decision.companyName, location: decision.jobLocation ?? undefined, department: decision.jobDepartment ?? undefined },
      vocabulary: vocab.map((v) => v.tag),
    },
    { refType: "decision", refId: decision.id, userId: decision.userId },
  );
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

export async function handleScoreJob(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { userId, jobId } = task.payload as unknown as TaskPayloads["score_job"];
  if (!userId) return { skipped: "no account on task" };
  const [job] = await deps.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job) return { skipped: "job not found" };
  if (job.status !== "open") return { skipped: "job is closed" };
  const [view] = await deps.db.select().from(schema.userJobs).where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId))).limit(1);
  if (!view) return { skipped: "role is not in this account's table" };
  const settings = await deps.userSettings(userId);
  const [choice] = await deps.db.select({ decision: schema.decisions.decision }).from(schema.decisions)
    .where(and(eq(schema.decisions.userId, userId), eq(schema.decisions.jobId, jobId), eq(schema.decisions.superseded, false))).limit(1);
  if (!view.inTable && choice?.decision !== "apply") return { skipped: "role does not match and is not shortlisted" };
  // Asked before any of the scoring evidence is gathered: an account with nothing left to spend
  // skips this role, and the task finishes done rather than failing at the hold and retrying.
  const scoreStop = await aiBudgetStop(deps, userId);
  if (scoreStop) return { skipped: scoreStop };

  const [company] = await deps.db.select().from(schema.companies).where(eq(schema.companies.id, job.companyId)).limit(1);
  const profile = await latestProfileFor(deps.db, userId);
  const digest = await buildDigest(deps, userId);

  const [library] = await deps.db.select({ content: schema.cvLibraries.content }).from(schema.cvLibraries)
    .where(eq(schema.cvLibraries.userId, userId)).orderBy(desc(schema.cvLibraries.version)).limit(1);
  const input = {
      profileMarkdown: profile?.markdown ?? settings.seedProfile ?? "",
      decisionDigest: digest,
      job: {
        title: job.title,
        company: company?.name ?? "",
        location: job.location ?? undefined,
        department: job.department ?? undefined,
        employmentType: job.employmentType ?? undefined,
        // Near-miss candidates are scored on metadata only (no description fetch for roles outside the gate).
        description: view.inTable ? job.descriptionText ?? undefined : undefined,
        keywordTerms: view.keywordTerms,
      },
    };
  if (library) {
    const entries = library.content.entries.flatMap(entry => {
      const eligible = eligibleCvEvidence(entry);
      return eligible ? [{ ...eligible, heading: evidenceHeading(library.content, eligible) }] : [];
    });
    input.profileMarkdown += "\nEvidence library (absence is not proof of inability):\n" + JSON.stringify({ profile: library.content.profile, employment: library.content.employment?.filter(job => entries.some(entry => entry.employmentId === job.id)), entries });
  }
  const fingerprint = sha1(JSON.stringify([input, modelForCallSite(settings, "A5")]));
  const key = `internal:scoreInput:${userId}:${job.id}`;
  const [previous] = await deps.db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, key));
  if (view.fitScore !== null && previous?.value === fingerprint) return { skipped: "scoring inputs unchanged" };
  const result = await deps.ai.scoreJob(input,
    { refType: "job", refId: job.id, userId },
  );
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
      hidden: false,
      updatedAt: deps.now(),
    })
    .where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, job.id)));
  await tx.insert(schema.settings).values({ key, value: fingerprint }).onConflictDoUpdate({ target: schema.settings.key, set: { value: fingerprint, updatedAt: deps.now() } });
  await tx.insert(schema.jobEvents).values({ jobId: job.id, userId, type: "scored", payload: { score: result.score, verdict: result.verdict } });
  return { score: result.score, verdict: result.verdict };
  });
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

  const result = await deps.ai.synthesizeProfile({
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
  }, { refType: "profile", refId: userId, userId });
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

export async function handleSuggestFilters(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { userId } = (task.payload ?? {}) as TaskPayloads["suggest_filters"];
  if (!userId) return { skipped: "no account on task" };
  const filterStop = await aiBudgetStop(deps, userId);
  if (filterStop) return { skipped: filterStop };
  const settings = await deps.userSettings(userId);
  const decisions = await decisionRows(deps, userId, 300);
  if (decisions.length === 0) return { skipped: "no decisions" };

  const nearMissIds = await deps.db
    .select({ id: schema.userJobs.jobId })
    .from(schema.userJobs)
    .where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.nearMiss, true)))
    .limit(200);
  const nearMissDecisions = decisions.filter((d) => nearMissIds.some((n) => n.id === d.jobId));

  const previouslyRejected = await deps.db
    .select({ type: schema.filterSuggestions.type, value: schema.filterSuggestions.value })
    .from(schema.filterSuggestions)
    .where(and(eq(schema.filterSuggestions.userId, userId), eq(schema.filterSuggestions.status, "rejected")));

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

  const result = await deps.ai.suggestFilters({
    includeKeywords: settings.gate.includeKeywords,
    excludeKeywords: settings.gate.excludeKeywords,
    locationTerms: settings.gate.locationTerms,
    decisions: decisions.map(map),
    nearMissDecisions: nearMissDecisions.map(map),
    previouslyRejected: previouslyRejected.map((r) => ({ type: r.type, value: r.value })),
  }, { refType: "filters", refId: userId, userId });
  if (!result) return { skipped: "no ai result" };

  let inserted = 0;
  for (const s of result) {
    const duplicate = await deps.db
      .select({ id: schema.filterSuggestions.id })
      .from(schema.filterSuggestions)
      .where(and(eq(schema.filterSuggestions.userId, userId), eq(schema.filterSuggestions.type, s.type), sql`${schema.filterSuggestions.value}::text = ${JSON.stringify(s.value)}`, inArray(schema.filterSuggestions.status, ["pending", "rejected"])))
      .limit(1);
    if (duplicate.length) continue;
    await deps.db.insert(schema.filterSuggestions).values({ userId, type: s.type, value: s.value, evidence: s.evidence, rationale: s.rationale });
    inserted++;
  }
  return { suggestions: inserted };
}

/** Re-evaluate the keyword and location gate for one account, or every account, after a settings change. */
export async function handleReevaluateGate(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { userId, companyId } = (task.payload ?? {}) as TaskPayloads["reevaluate_gate"];
  return withResourceLease(deps, "reevaluate-gate", async locked => {
    deps.invalidateSettings();
    const users = userId ? [userId] : await listUserIds(deps.db);
    const outcomes: Record<string, unknown> = {};
    for (const id of users) {
      const settings = await deps.userSettings(id);
      outcomes[id] = await deps.db.transaction(async tx => {
        await locked.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
        return reevaluateGate(tx as unknown as WorkerDeps["db"], id, settings, deps.now(), { companyId });
      });
    }
    return { accounts: users.length, outcomes };
  });
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
    const values = rows.slice(offset, offset + 250).map(row => {
      const payload = { userId, jobId: row.id };
      return { type: 'score_job' as const, payload, dedupeKey: dedupeKeyFor('score_job', payload), priority: row.shortlisted ? 1 : priorityFor('score_job') };
    });
    const inserted = await deps.db.insert(schema.tasks).values(values).onConflictDoNothing().returning({ id: schema.tasks.id });
    queued += inserted.length;
  }
  return { queued };
}
