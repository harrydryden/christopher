import { schema, enqueueTask, type Task } from "@christopher/db";
import { decisionDigest } from "@christopher/ai";
import { dedupeKeyFor, evaluateGate, modelForCallSite, priorityFor, type AppSettings } from "@christopher/core";
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { WorkerDeps } from "../context";
import { aiBudgetExceeded } from "../context";
import { log } from "../log";

const SEED_TAGS: Array<{ tag: string; description: string }> = [
  { tag: "seniority:too_junior", description: "Role is below the target seniority band" },
  { tag: "seniority:too_senior", description: "Role is above the target seniority band" },
  { tag: "location:not_commutable", description: "Location is too far to commute" },
  { tag: "location:wrong_country", description: "Location is in the wrong country" },
  { tag: "domain:uninterested", description: "Subject domain does not appeal" },
  { tag: "domain:interested", description: "Subject domain appeals" },
  { tag: "role_type:not_operations", description: "Not the kind of operations work wanted" },
  { tag: "company:stage", description: "Company stage is wrong" },
  { tag: "company:sector", description: "Company sector is wrong" },
  { tag: "comp:too_low", description: "Compensation below the floor" },
  { tag: "title:mismatch", description: "Title does not match the work wanted" },
  { tag: "timing", description: "Wrong timing" },
  { tag: "already_applied", description: "Already applied to this or a similar role" },
];

export async function ensureSeedTags(deps: WorkerDeps): Promise<void> {
  await deps.db.insert(schema.tagVocabulary).values(SEED_TAGS.map((t) => ({ ...t, createdBy: "seed" as const }))).onConflictDoNothing();
}

export async function handleTagReason(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { decisionId } = task.payload as unknown as { decisionId: string };
  const [decision] = await deps.db.select().from(schema.decisions).where(eq(schema.decisions.id, decisionId)).limit(1);
  if (!decision) return { skipped: "decision not found" };
  if (!decision.reason.trim()) return { skipped: "no reason text" };
  if (await aiBudgetExceeded(deps)) return { skipped: "ai budget exceeded" };

  await ensureSeedTags(deps);
  const vocab = await deps.db.select({ tag: schema.tagVocabulary.tag }).from(schema.tagVocabulary).where(eq(schema.tagVocabulary.accepted, true));
  const result = await deps.ai.tagReason(
    {
      reason: decision.reason,
      decision: decision.decision,
      job: { title: decision.jobTitle, company: decision.companyName, location: decision.jobLocation ?? undefined, department: decision.jobDepartment ?? undefined },
      vocabulary: vocab.map((v) => v.tag),
    },
    { refType: "decision", refId: decision.id },
  );
  if (!result) return { skipped: "no ai result" };

  await deps.db.update(schema.decisions).set({ tags: result.tags }).where(eq(schema.decisions.id, decision.id));
  if (result.proposedNewTags.length) {
    await deps.db
      .insert(schema.tagVocabulary)
      .values(result.proposedNewTags.map((t) => ({ tag: t.tag, description: t.description, createdBy: "model" as const, accepted: false })))
      .onConflictDoNothing();
  }
  return { tags: result.tags, proposed: result.proposedNewTags.length };
}

export async function handleScoreJob(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { jobId } = task.payload as unknown as { jobId: string; nearMiss?: boolean };
  const [job] = await deps.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job) return { skipped: "job not found" };
  const settings = await deps.settings();
  if (!job.inTable && !(job.nearMiss && settings.nearMissEnabled)) return { skipped: "not in table and near-miss disabled" };
  if (await aiBudgetExceeded(deps)) return { skipped: "ai budget exceeded" };

  const [company] = await deps.db.select().from(schema.companies).where(eq(schema.companies.id, job.companyId)).limit(1);
  const profile = await latestProfile(deps);
  const digest = await buildDigest(deps);

  const result = await deps.ai.scoreJob(
    {
      profileMarkdown: profile?.markdown ?? settings.seedProfile ?? "",
      decisionDigest: digest,
      job: {
        title: job.title,
        company: company?.name ?? "",
        location: job.location ?? undefined,
        department: job.department ?? undefined,
        employmentType: job.employmentType ?? undefined,
        // Near-miss candidates are scored on metadata only (no description fetch for roles outside the gate).
        description: job.inTable ? job.descriptionText ?? undefined : undefined,
        keywordTerms: job.keywordTerms,
      },
    },
    { refType: "job", refId: job.id },
  );
  if (!result) return { skipped: "no ai result" };

  await deps.db
    .update(schema.jobs)
    .set({
      fitScore: result.score,
      fitVerdict: result.verdict,
      fitRationale: result.rationale,
      fitProfileVersion: profile?.version ?? null,
      fitScoredAt: deps.now(),
      hidden: settings.hideThreshold !== null && job.inTable ? result.score < settings.hideThreshold : false,
    })
    .where(eq(schema.jobs.id, job.id));
  await deps.db.insert(schema.jobEvents).values({ jobId: job.id, type: "scored", payload: { score: result.score, verdict: result.verdict } });
  return { score: result.score, verdict: result.verdict };
}

export async function latestProfile(deps: WorkerDeps) {
  const [row] = await deps.db.select().from(schema.preferenceProfiles).orderBy(desc(schema.preferenceProfiles.version)).limit(1);
  return row ?? null;
}

async function decisionRows(deps: WorkerDeps, limit = 200) {
  return deps.db
    .select()
    .from(schema.decisions)
    .where(eq(schema.decisions.superseded, false))
    .orderBy(desc(schema.decisions.createdAt))
    .limit(limit);
}

async function buildDigest(deps: WorkerDeps): Promise<string> {
  const rows = await decisionRows(deps, 100);
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
  const { force } = (task.payload ?? {}) as { force?: boolean };
  if (await aiBudgetExceeded(deps)) return { skipped: "ai budget exceeded" };
  const settings = await deps.settings();
  const current = await latestProfile(deps);
  const decisions = await decisionRows(deps, 500);
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
    .where(eq(schema.companySuggestions.status, "rejected"))
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
  });
  if (!result) return { skipped: "no ai result" };

  const version = (current?.version ?? 0) + 1;
  const openQuestions = result.openQuestions.map((q) => ({ id: q.id, question: q.question }));
  await deps.db.insert(schema.preferenceProfiles).values({
    version,
    markdown: result.markdown,
    pinnedStatements: current?.pinnedStatements ?? [],
    openQuestions,
    sourceDecisionCount: decisions.length,
    model: modelForCallSite(settings, "A7"),
    generatedAt: deps.now(),
  });
  log.info("profile synthesised", { version, decisions: decisions.length, questions: openQuestions.length });

  const p = { onlyInTable: true };
  await enqueueTask(deps.db, "rescore_all", p, { dedupeKey: dedupeKeyFor("rescore_all", p), priority: priorityFor("rescore_all") });
  return { version, decisions: decisions.length };
}

export async function handleSuggestFilters(task: Task, deps: WorkerDeps): Promise<unknown> {
  if (await aiBudgetExceeded(deps)) return { skipped: "ai budget exceeded" };
  const settings = await deps.settings();
  const decisions = await decisionRows(deps, 300);
  if (decisions.length < 5) return { skipped: "not enough decisions" };

  const nearMissIds = await deps.db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(eq(schema.jobs.nearMiss, true))
    .limit(200);
  const nearMissDecisions = decisions.filter((d) => nearMissIds.some((n) => n.id === d.jobId));

  const previouslyRejected = await deps.db
    .select({ type: schema.filterSuggestions.type, value: schema.filterSuggestions.value })
    .from(schema.filterSuggestions)
    .where(eq(schema.filterSuggestions.status, "rejected"));

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
  });
  if (!result) return { skipped: "no ai result" };

  let inserted = 0;
  for (const s of result) {
    const duplicate = await deps.db
      .select({ id: schema.filterSuggestions.id })
      .from(schema.filterSuggestions)
      .where(and(eq(schema.filterSuggestions.type, s.type), sql`${schema.filterSuggestions.value}::text = ${JSON.stringify(s.value)}`, inArray(schema.filterSuggestions.status, ["pending", "rejected"])))
      .limit(1);
    if (duplicate.length) continue;
    await deps.db.insert(schema.filterSuggestions).values({ type: s.type, value: s.value, evidence: s.evidence, rationale: s.rationale });
    inserted++;
  }
  return { suggestions: inserted };
}

/** Re-evaluate the keyword and location gate for every stored job after a settings change. */
export async function handleReevaluateGate(task: Task, deps: WorkerDeps): Promise<unknown> {
  const settings = await deps.settings();
  const cutoff = new Date(deps.now().getTime() - settings.showClosedDays * 86_400_000);
  const rows = await deps.db
    .select()
    .from(schema.jobs)
    .where(or(eq(schema.jobs.status, "open"), gte(schema.jobs.closedAt, cutoff)));

  let changed = 0;
  const toScore: string[] = [];
  const descriptionMatch = settings.gate.matchFields.includes("description");
  for (const job of rows) {
    const gate = evaluateGate(
      {
        title: job.title,
        department: job.department,
        description: descriptionMatch ? job.descriptionText : null,
        location: job.location,
        locations: job.locations,
        remote: job.remote,
      },
      settings.gate,
    );
    // Matches the rule used when a role is first stored: the location filter is a hard boundary,
    // so a role outside it is never surfaced as a near miss.
    const nearMiss = !gate.inTable && settings.nearMissEnabled && !gate.excluded && gate.locationOk;
    const hidden = settings.hideThreshold !== null && gate.inTable && job.fitScore !== null ? job.fitScore < settings.hideThreshold : false;
    if (
      gate.inTable === job.inTable &&
      gate.keywordMatched === job.keywordMatched &&
      gate.excluded === job.excluded &&
      gate.locationOk === job.locationOk &&
      nearMiss === job.nearMiss &&
      hidden === job.hidden
    ) {
      continue;
    }
    await deps.db
      .update(schema.jobs)
      .set({
        keywordMatched: gate.keywordMatched,
        keywordTerms: gate.keywordTerms,
        excluded: gate.excluded,
        locationOk: gate.locationOk,
        inTable: gate.inTable,
        nearMiss,
        hidden,
        updatedAt: deps.now(),
      })
      .where(eq(schema.jobs.id, job.id));
    changed++;
    if ((gate.inTable || nearMiss) && job.fitScore === null && job.status === "open") toScore.push(job.id);
  }

  for (const id of toScore.slice(0, 200)) {
    const p = { jobId: id };
    await enqueueTask(deps.db, "score_job", p, { dedupeKey: dedupeKeyFor("score_job", p), priority: priorityFor("score_job") });
  }
  log.info("gate re-evaluated", { examined: rows.length, changed, queuedForScoring: Math.min(toScore.length, 200) });
  return { examined: rows.length, changed, queuedForScoring: Math.min(toScore.length, 200) };
}

export async function handleRescoreAll(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { onlyInTable } = (task.payload ?? {}) as { onlyInTable?: boolean };
  const settings = await deps.settings();
  const profile = await latestProfile(deps);
  const rows = await deps.db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.status, "open"),
        onlyInTable === false ? undefined : eq(schema.jobs.inTable, true),
        profile ? or(isNull(schema.jobs.fitProfileVersion), lt(schema.jobs.fitProfileVersion, profile.version)) : undefined,
      ),
    )
    .limit(500);
  let queued = 0;
  for (const row of rows) {
    const p = { jobId: row.id };
    if (await enqueueTask(deps.db, "score_job", p, { dedupeKey: dedupeKeyFor("score_job", p), priority: priorityFor("score_job") })) queued++;
  }
  if (settings.nearMissEnabled && onlyInTable === false) {
    const near = await deps.db.select({ id: schema.jobs.id }).from(schema.jobs).where(and(eq(schema.jobs.nearMiss, true), eq(schema.jobs.status, "open"))).limit(200);
    for (const row of near) {
      const p = { jobId: row.id, nearMiss: true };
      if (await enqueueTask(deps.db, "score_job", p, { dedupeKey: dedupeKeyFor("score_job", p), priority: priorityFor("score_job") })) queued++;
    }
  }
  return { queued };
}
