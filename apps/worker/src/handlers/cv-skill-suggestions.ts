import { and, eq } from "drizzle-orm";
import { CvLibrarySchema, MAX_CV_SKILL_DRAFT_CONTEXT_BYTES, cvDraftContextHighlightedSkills, cvReusableSkillRows,
  cvSkillEvidenceRows, cvSkillSuggestionInputHash, groundedCvSkillSuggestions, isCvSkillDraftContext, type TaskPayloads } from "@col/core";
import { estimateCostUsd } from "@col/ai";
import { CvTargetingBriefSchema, cvEligibleSkillLibrary, cvSkillSourcePolicy } from "@col/core/cv-targeting";
import { cvDrafts, cvSkillSuggestionRuns, latestCvLibrary, type Db, type Task } from "@col/db";
import { openAccountAiPass } from "../account-ai-pass";
import type { WorkerDeps } from "../context";
import type { TaskRunContext } from "../queue";

/** One paid, bounded proposal and one independent semantic check; neither writes the Library. */
export async function handleSuggestCvSkills(task: Task, deps: WorkerDeps, ctx?: TaskRunContext): Promise<unknown> {
  const { userId, draftId, runId, baseRevision, draftContext } = (task.payload ?? {}) as TaskPayloads["suggest_cv_skills"];
  if (!userId || !draftId || !runId) return { skipped: "invalid suggestion task" };
  const [run] = await deps.db.select().from(cvSkillSuggestionRuns)
    .where(and(eq(cvSkillSuggestionRuns.id, runId), eq(cvSkillSuggestionRuns.userId, userId), eq(cvSkillSuggestionRuns.draftId, draftId))).limit(1);
  if (!run || run.status !== "queued") return { skipped: "suggestion run superseded" };
  const finish = async (status: "ready" | "failed", suggestions: typeof run.suggestions = [], error: string | null = null) => {
    const written = await deps.db.transaction(async tx => {
      await deps.assertOwnership?.(tx as unknown as Db);
      if (status === "ready") {
        const [currentDraft] = await tx.select({ status: cvDrafts.status, content: cvDrafts.content, revision: cvDrafts.revision,
          jobDescription: cvDrafts.jobDescription, targetingBrief: cvDrafts.targetingBrief }).from(cvDrafts)
          .where(and(eq(cvDrafts.id, draftId), eq(cvDrafts.userId, userId))).limit(1).for("share");
        const currentLibrary = await latestCvLibrary(tx as unknown as Db, userId);
        const currentBrief = currentDraft?.targetingBrief ? CvTargetingBriefSchema.parse(currentDraft.targetingBrief) : null;
        const currentRows = currentLibrary ? cvSkillEvidenceRows(cvEligibleSkillLibrary(CvLibrarySchema.parse(currentLibrary.content), currentBrief)) : [];
        if (!currentDraft?.content || !["ready", "failed"].includes(currentDraft.status) || !currentLibrary
          || currentDraft.revision !== baseRevision || !draftContext
          || currentLibrary.version !== run.libraryVersion
          || cvSkillSuggestionInputHash(currentLibrary.version, draftId, currentDraft.jobDescription, currentRows,
            cvDraftContextHighlightedSkills(draftContext), draftContext, baseRevision, cvSkillSourcePolicy(currentBrief)) !== run.inputHash) {
          status = "failed"; suggestions = []; error = "Your Experience or target role changed. Refresh suggestions.";
        }
      }
      return tx.update(cvSkillSuggestionRuns).set({ status, suggestions, error, updatedAt: deps.now() })
        .where(and(eq(cvSkillSuggestionRuns.id, runId), eq(cvSkillSuggestionRuns.userId, userId), eq(cvSkillSuggestionRuns.status, "queued")))
        .returning({ id: cvSkillSuggestionRuns.id });
    });
    return written.length ? { status, count: suggestions.length } : { skipped: "suggestion run superseded" };
  };
  const [draft] = await deps.db.select({ jobDescription: cvDrafts.jobDescription, status: cvDrafts.status, content: cvDrafts.content,
    revision: cvDrafts.revision, targetingBrief: cvDrafts.targetingBrief })
    .from(cvDrafts).where(and(eq(cvDrafts.id, draftId), eq(cvDrafts.userId, userId))).limit(1);
  const latest = await latestCvLibrary(deps.db, userId);
  if (!draft?.content || !["ready", "failed"].includes(draft.status) || !latest)
    return finish("failed", [], "This CV or Experience is no longer available for suggestions.");
  if (!Number.isInteger(baseRevision) || baseRevision! < 0 || !isCvSkillDraftContext(draftContext))
    return finish("failed", [], "This skill request predates the current Write section. Generate skills again.");
  const draftContextBytes = Buffer.byteLength(JSON.stringify(draftContext));
  if (draftContextBytes > MAX_CV_SKILL_DRAFT_CONTEXT_BYTES)
    return finish("failed", [], "This CV draft is too long for skill suggestions. Shorten it, then generate skills again.");
  if (draft.revision !== baseRevision)
    return finish("failed", [], "This CV changed. Generate skills again.");
  const brief = draft.targetingBrief ? CvTargetingBriefSchema.parse(draft.targetingBrief) : null;
  const library = cvEligibleSkillLibrary(CvLibrarySchema.parse(latest.content), brief);
  const rows = cvSkillEvidenceRows(library);
  const highlightedSkills = cvDraftContextHighlightedSkills(draftContext);
  const reusableSkills = cvReusableSkillRows(library);
  const inputHash = cvSkillSuggestionInputHash(latest.version, draftId, draft.jobDescription, rows, highlightedSkills,
    draftContext, baseRevision, cvSkillSourcePolicy(brief));
  if (latest.version !== run.libraryVersion || inputHash !== run.inputHash)
    return finish("failed", [], "Your Experience or target role changed. Refresh suggestions.");
  if (!rows.length) return finish("ready");
  // Do not silently sample a person's Experience: a partial source set could make a suggestion
  // appear grounded while hiding a qualification or negation elsewhere in the confirmed text.
  const sourceLength = rows.reduce((total, row) => total + row.id.length + row.text.length, 0);
  const skillHintLength = JSON.stringify({ highlightedSkills, reusableSkills }).length;
  if (sourceLength > 120_000 || draft.jobDescription.length > 20_000 || skillHintLength > 60_000)
    return finish("failed", [], "Confirmed Experience, saved skills or target role is too long for this check. Shorten it, then refresh suggestions.");

  const settings = await deps.userSettings(userId);
  const model = settings.cvModel;
  const pass = openAccountAiPass(deps, { userId, settings, callSite: "CV", model, refId: `cv_skill_suggestions:${runId}`, signal: ctx?.signal });
  if (!pass.ai.enabled) return finish("failed", [], "Skill suggestions are unavailable at present.");
  const proposalBytes = Buffer.byteLength(JSON.stringify({ rows, highlightedSkills, reusableSkills }))
    + Buffer.byteLength(draft.jobDescription) + draftContextBytes;
  // The verifier can cite every source, but sends each row only once. Reserve both requests,
  // including a generous ceiling for sixteen candidate records and prompt framing.
  const verificationBytes = proposalBytes + 16_000;
  const expected = estimateCostUsd(model, { inputTokens: Math.ceil((proposalBytes + verificationBytes) / 2), outputTokens: 6_000,
    cacheReadTokens: 0, cacheWriteTokens: 0 });
  const admitted = await pass.admit(expected);
  if ("refused" in admitted) return finish("failed", [], admitted.refused);
  try {
    const proposed = await pass.ai.suggestCvSkills({ rows, highlightedSkills, reusableSkills, draftContext,
      description: draft.jobDescription, model },
      { userId, refType: "cv_skill_suggestions", refId: runId });
    if (!proposed) return finish("failed", [], "No skill suggestions were returned. Try refreshing later.");
    const candidates = proposed.suggestions.map(item => ({ category: item.category, label: item.label,
      evidenceQuote: item.evidenceQuote, roleQuote: item.roleQuote, sourceId: item.sourceId }));
    const cited = new Set(candidates.map(candidate => candidate.sourceId));
    const sources = rows.filter(row => cited.has(row.id));
    const verified = await pass.ai.verifyCvSkills({ candidates, sources, description: draft.jobDescription, model },
      { userId, refType: "cv_skill_suggestions", refId: runId });
    if (!verified) return finish("failed", [], "Suggestions could not be checked against your Experience. Refresh later.");
    const stillLatest = await latestCvLibrary(deps.db, userId);
    if (stillLatest?.version !== run.libraryVersion) return finish("failed", [], "Your Experience changed. Refresh suggestions.");
    return finish("ready", groundedCvSkillSuggestions(proposed, rows, draft.jobDescription, verified));
  } catch (error) {
    if (ctx?.signal.aborted) throw error;
    return finish("failed", [], "Skill suggestions stopped before they could be checked. Refresh later.");
  } finally {
    await admitted.release();
  }
}
