import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, grantCvCredits, publishCvAutoBaseline, schema, type Db } from "@col/db";
import { CvContentSchema, DEFAULT_CV_THEME } from "@col/core";
import { cvClaimItems, cvEvidenceItems, cvTextItems } from "@col/core/cv-assessment";
import { createCvAssessment } from "@col/core/cv-review";
import { cvEditingTargetsFor } from "@col/core/cv-editing-modes";
import { rubricFixture, reviewFixture } from "../../../../packages/core/test/cv-review-fixture";
import { runMigrations } from "@col/db/migrate";
import { createTestDb } from "@/test/db";
import { signInTestUser } from "@/test/auth";
import { applyCvRefinementRebase, createCvApplicationContext, createManualCvEdition, generateRefinedCv,
  openOrClaimAutoCv, previewCvRefinementRebase, updateCvApplicationDescription,
  resetCvRefinement, saveCvRefinement, saveManualCvEdition } from "./cv-editing";
import { saveCvDraft } from "./cv";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let userId: string;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => session ? { value: session } : undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

const library = { name: "Ada Example", contact: "London", profile: "Operations lead",
  entries: [{ id: "role", kind: "experience" as const, heading: "Operations Manager",
    details: "Reduced backlog by 20%", confirmedResponsibilities: ["Reduced backlog by 20%"] }] };
const description = "Lead the operations team, improve service quality, and deliver measurable outcomes across the organisation.";

beforeAll(async () => {
  const client = createTestDb(); database = client.db; pool = client.pool;
  await runMigrations(database); process.env.SESSION_SECRET = "cv-editing-test-secret";
});
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate ai_calls, ai_reservations, applications, cv_versions, cv_drafts,
    cv_libraries, companies, tasks, settings, user_settings, users restart identity cascade`);
  const signed = await signInTestUser(database, process.env.SESSION_SECRET!);
  session = signed.cookie; userId = signed.user.id;
});

async function context() {
  const opened = await createCvApplicationContext({ requestKey: `paste:${crypto.randomUUID()}`,
    companyName: "Acme", jobTitle: "Head of Operations", description });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error(opened.error);
  expect(opened.contextId, JSON.stringify(opened)).toMatch(/^[0-9a-f-]{36}$/);
  expect(opened.descriptionVersionId, JSON.stringify(opened)).toMatch(/^[0-9a-f-]{36}$/);
  return opened;
}

it("claims one immutable Auto build, one task and one credit for concurrent deliberate updates", async () => {
  const opened = await context();
  await database.insert(schema.cvLibraries).values({ userId, version: 1, content: library });
  await grantCvCredits(database, { userId, source: "admin", units: 2, externalRef: `auto-${userId}` });
  const [a, b] = await Promise.all([
    openOrClaimAutoCv(opened.contextId, "update"), openOrClaimAutoCv(opened.contextId, "update"),
  ]);
  expect(a.ok, JSON.stringify(a)).toBe(true); expect(b.ok, JSON.stringify(b)).toBe(true);
  if (!a.ok || !b.ok) return;
  expect(a.baselineId).toBe(b.baselineId);
  expect(a.draftId).toBe(b.draftId);
  expect([a.charged, b.charged].sort()).toEqual([false, true]);
  expect(await database.select().from(schema.cvAutoBaselines)).toHaveLength(1);
  expect((await database.select().from(schema.tasks)).filter(task => task.type === "generate_cv")).toHaveLength(1);
  expect((await database.select().from(schema.creditReservations)).filter(row => row.status === "reserved")).toHaveLength(1);
  const reopened = await openOrClaimAutoCv(opened.contextId, "open");
  expect(reopened).toMatchObject({ ok: true, charged: false, baselineId: a.baselineId });
  expect(await database.select().from(schema.creditReservations)).toHaveLength(1);
  const content = CvContentSchema.parse({ name: "Ada Example", contact: "London", summary: "Operations lead",
    sections: [{ entryId: "role", kind: "experience", heading: "Operations Manager",
      bullets: ["Reduced backlog by 20%"] }], gaps: [] });
  const targets = cvEditingTargetsFor(content, () => crypto.randomUUID());
  const rubric = rubricFixture(description);
  const review = reviewFixture({ rubric, cv: cvTextItems(content), claims: cvClaimItems(content),
    evidence: cvEvidenceItems(library) });
  const assessment = createCvAssessment({ content, description, library, rubric, review,
    model: "test", pageCount: 1 });
  const plan = { requirements: [{ requirementId: "r1", status: "demonstrated" as const,
    evidence: [{ sourceId: "entry:role:row:0", quote: "Reduced backlog by 20%" }],
    reason: "Confirmed contribution" }], gapQuestions: [] };
  await database.transaction(tx => publishCvAutoBaseline(tx, { userId, baselineId: a.baselineId!,
    sourceDraftId: a.draftId!, content, assessment, librarySnapshot: library, editingTargets: targets,
    tailoringPlan: plan }));
  await database.update(schema.cvDrafts).set({ status: "ready", content, editingTargets: targets })
    .where(eq(schema.cvDrafts.id, a.draftId!));
  const completed = await openOrClaimAutoCv(opened.contextId, "update");
  expect(completed).toMatchObject({ ok: true, status: "ready", charged: false,
    baselineId: a.baselineId, draftId: a.draftId });
  expect(await database.select().from(schema.creditReservations)).toHaveLength(1);
  await database.insert(schema.cvLibraries).values({ userId, version: 2,
    content: { ...library, profile: "Changed profile after publication" } });
  const pinned = await openOrClaimAutoCv(opened.contextId, "open");
  expect(pinned).toMatchObject({ ok: true, status: "ready", charged: false,
    baselineId: a.baselineId, draftId: a.draftId });
  expect(await database.select().from(schema.tasks)).toHaveLength(1);
  await database.delete(schema.cvDrafts).where(eq(schema.cvDrafts.id, a.draftId!));
  const copied = await createManualCvEdition(opened.contextId, opened.descriptionVersionId,
    { kind: "baseline", id: a.baselineId! });
  expect(copied).toMatchObject({ ok: true, charged: false });
  if (!copied.ok) return;
  const [manual] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, copied.draftId));
  expect(manual?.assessment).toEqual(assessment);
  expect(manual?.semanticAuditCache?.identity).toMatch(/^[a-f0-9]{64}$/);
  expect(manual?.buildCheckpoint?.sourceRubric).toEqual(rubric);
  const [retainedPlan] = await database.select().from(schema.cvTailoringPlans)
    .where(eq(schema.cvTailoringPlans.draftId, copied.draftId));
  expect(retainedPlan?.plan).toEqual(plan);
  const layoutOnly = await saveManualCvEdition(copied.draftId, manual!.revision,
    { ...content, theme: { ...DEFAULT_CV_THEME, maxPages: 2, bodySizePt: 12 } }, manual!.editingTargets);
  expect(layoutOnly.ok, JSON.stringify(layoutOnly)).toBe(true);
  if (!layoutOnly.ok) return;
  const [savedLayout] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, layoutOnly.draftId));
  expect(savedLayout?.assessment).toBeNull();
  expect(savedLayout?.semanticAuditCache).toEqual(manual!.semanticAuditCache);
  expect(savedLayout?.buildCheckpoint?.sourceRubric).toEqual(rubric);
  const [layoutPlan] = await database.select().from(schema.cvTailoringPlans)
    .where(eq(schema.cvTailoringPlans.draftId, layoutOnly.draftId));
  expect(layoutPlan?.plan).toEqual(plan);
  expect((await database.select().from(schema.tasks)).filter(task => task.type === "generate_cv")).toHaveLength(1);
  const appearance = await saveCvRefinement(opened.contextId, 0, { sourceKind: "baseline",
    sourceId: a.baselineId!, kind: "structured", target: { type: "appearance" }, order: 0,
    structured: { kind: "appearance", theme: { ...DEFAULT_CV_THEME, maxPages: 2, bodySizePt: 12 } } });
  expect(appearance).toMatchObject({ ok: true, version: 1 });
  if (!appearance.ok) return;
  const freeLayout = await generateRefinedCv(opened.contextId, appearance.version, "baseline", a.baselineId!);
  expect(freeLayout).toMatchObject({ ok: true, status: "ready", charged: false });
  if (!freeLayout.ok || !freeLayout.draftId) return;
  const [layoutRefine] = await database.select().from(schema.cvDrafts)
    .where(eq(schema.cvDrafts.id, freeLayout.draftId));
  expect(layoutRefine?.assessment).toBeNull();
  expect(layoutRefine?.semanticAuditCache?.identity).toMatch(/^[a-f0-9]{64}$/);
  expect(layoutRefine?.buildCheckpoint?.sourceRubric).toEqual(rubric);
  expect((await database.select().from(schema.cvTailoringPlans)
    .where(eq(schema.cvTailoringPlans.draftId, freeLayout.draftId)))[0]?.plan).toEqual(plan);
  const priority = await saveCvRefinement(opened.contextId, appearance.version, { sourceKind: "baseline",
    sourceId: a.baselineId!, kind: "structured", target: { type: "selection" }, order: 1,
    structured: { kind: "targeting", choices: { entries: [], presentation: { maxPages: 2, bodySizePt: 12 },
      emphasisRequirementIds: ["r1"], requirements: [{ id: "r1", text: "Lead measurable service improvements",
        essential: false }], acknowledgedEssentialOmissionIds: [] } } });
  expect(priority).toMatchObject({ ok: true, version: 2 });
  if (!priority.ok) return;
  const refinedPriority = await generateRefinedCv(opened.contextId, priority.version, "baseline", a.baselineId!);
  expect(refinedPriority).toMatchObject({ ok: true, status: "ready", charged: false });
  if (!refinedPriority.ok || !refinedPriority.draftId) return;
  const [priorityDraft] = await database.select().from(schema.cvDrafts)
    .where(eq(schema.cvDrafts.id, refinedPriority.draftId));
  expect(priorityDraft?.targetingBrief?.priority).toMatchObject({ state: "confirmed", rubric,
    requirements: [{ id: "r1", text: "Lead measurable service improvements", essential: false }] });
  expect(priorityDraft?.content?.summary).toBe(content.summary);
  expect(priorityDraft?.assessment).toBeNull();
  expect(priorityDraft?.buildCheckpoint?.sourceRubric).toEqual(rubric);
  expect(await database.select().from(schema.cvTailoringPlans)
    .where(eq(schema.cvTailoringPlans.draftId, refinedPriority.draftId))).toHaveLength(0);
  expect((await database.select().from(schema.tasks)).filter(task => task.type === "generate_cv")).toHaveLength(1);
  const instruction = await saveCvRefinement(opened.contextId, priority.version, { sourceKind: "baseline",
    sourceId: a.baselineId!, kind: "instruction", target: { type: "summary", id: targets.summaryId },
    text: "Emphasise the service improvement outcome", order: 2 });
  expect(instruction).toMatchObject({ ok: true, version: 3 });
  if (!instruction.ok) return;
  const paid = await generateRefinedCv(opened.contextId, instruction.version, "baseline", a.baselineId!);
  expect(paid).toMatchObject({ ok: true, status: "queued", charged: true });
  if (!paid.ok || !paid.draftId) return;
  const [queued] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, paid.draftId));
  expect(queued?.targetingBrief?.priority).toMatchObject({ state: "confirmed", rubric,
    requirements: [{ id: "r1", text: "Lead measurable service improvements", essential: false }] });
  expect(queued?.buildCheckpoint?.sourceRubric).toEqual(rubric);
  expect((await database.select().from(schema.tasks)).filter(task => task.type === "generate_cv")).toHaveLength(2);
});

it("starts Manual without a task and rejects a forged legacy Save that would learn wording or skills", async () => {
  const opened = await context();
  const started = await createManualCvEdition(opened.contextId, opened.descriptionVersionId);
  expect(started.ok, JSON.stringify(started)).toBe(true);
  if (!started.ok) return;
  expect(await database.select().from(schema.tasks)).toHaveLength(0);
  const content = { name: "Ada Example", contact: "London", summary: "Operations lead",
    sections: [{ entryId: `manual:${crypto.randomUUID()}`, kind: "experience" as const,
      heading: "Operations Manager", bullets: ["Reduced backlog by 20%"] }], gaps: [] };
  const [starter] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, started.draftId));
  const saved = await saveManualCvEdition(started.draftId, starter!.revision, content);
  expect(saved.ok).toBe(true);
  if (!saved.ok) return;
  const forged = new FormData(); forged.set("rememberWording", "on");
  forged.set("selectedSuggestionIds", JSON.stringify([crypto.randomUUID()]));
  const refusal = await saveCvDraft(saved.draftId, { ok: true }, forged);
  expect(refusal.ok).toBe(false);
  expect((await database.select().from(schema.cvLibraries)).length).toBe(0);
  expect((await database.select().from(schema.tasks)).length).toBe(0);
  expect((await database.select().from(schema.creditReservations)).length).toBe(0);
});

it("saves an unsaved Manual buffer against its pinned advert after this context receives a newer JD", async () => {
  const opened = await context();
  const started = await createManualCvEdition(opened.contextId, opened.descriptionVersionId);
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const [source] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, started.draftId));
  const nextRole = await updateCvApplicationDescription(opened.contextId, opened.descriptionVersionId,
    `${description} A new advert adds further responsibilities.`);
  expect(nextRole.ok, JSON.stringify(nextRole)).toBe(true);
  const wording = { name: "Ada Example", contact: "London", summary: "My saved wording",
    sections: [{ entryId: `manual:${crypto.randomUUID()}`, kind: "experience" as const,
      heading: "Operations Manager", bullets: ["A user-authored achievement"] }], gaps: [] };
  const saved = await saveManualCvEdition(started.draftId, source!.revision, wording);
  expect(saved).toMatchObject({ ok: true });
  if (!saved.ok) return;
  const [child] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, saved.draftId));
  expect(child).toMatchObject({ editingMode: "manual", parentId: source!.id,
    descriptionVersionId: opened.descriptionVersionId, jobDescription: description,
    jobSource: source!.jobSource, content: expect.objectContaining({ summary: wording.summary }) });
  expect(await database.select().from(schema.cvLibraries)).toHaveLength(0);
  expect(await database.select().from(schema.tasks)).toHaveLength(0);
  expect(await database.select().from(schema.creditReservations)).toHaveLength(0);
});

it("projects two successive exact Refine changes from Auto without another task or credit", async () => {
  const opened = await context();
  await database.insert(schema.cvLibraries).values({ userId, version: 1, content: library });
  await grantCvCredits(database, { userId, source: "admin", units: 2, externalRef: `refine-${userId}` });
  const claimed = await openOrClaimAutoCv(opened.contextId, "update");
  expect(claimed.ok, JSON.stringify(claimed)).toBe(true);
  if (!claimed.ok || !claimed.baselineId || !claimed.draftId) return;
  const content = CvContentSchema.parse({ name: "Ada Example", contact: "London", summary: "Operations lead",
    sections: [{ entryId: "role", kind: "experience", heading: "Operations Manager",
      bullets: ["Reduced backlog by 20%"], bulletSources: [["entry:role:row:0"]] }], gaps: [] });
  const targets = cvEditingTargetsFor(content, () => crypto.randomUUID());
  await database.transaction(tx => publishCvAutoBaseline(tx, { userId, baselineId: claimed.baselineId!,
    sourceDraftId: claimed.draftId!, content, librarySnapshot: library, editingTargets: targets }));
  await database.update(schema.cvDrafts).set({ status: "ready", content, editingTargets: targets })
    .where(eq(schema.cvDrafts.id, claimed.draftId));
  const first = await saveCvRefinement(opened.contextId, 0, { sourceKind: "baseline",
    sourceId: claimed.baselineId, kind: "exact_wording", target: { type: "summary", id: targets.summaryId },
    text: "Operations leader with measured delivery", order: 0 });
  expect(first).toMatchObject({ ok: true, version: 1 });
  if (!first.ok) return;
  const one = await generateRefinedCv(opened.contextId, first.version, "baseline", claimed.baselineId);
  expect(one).toMatchObject({ ok: true, status: "ready", charged: false });
  if (!one.ok || !one.draftId) return;
  const [oneDraft] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, one.draftId));
  expect(oneDraft?.content?.summary).toBe("Operations leader with measured delivery");
  expect(oneDraft?.editingTargets?.summaryId).toBe(targets.summaryId);
  const second = await saveCvRefinement(opened.contextId, first.version, { sourceKind: "draft",
    sourceId: one.draftId, kind: "exact_wording", target: { type: "bullet", id: targets.sections[0]!.bulletIds[0] },
    text: "Cut the backlog by 20%", order: 1 });
  expect(second).toMatchObject({ ok: true, version: 2 });
  if (!second.ok) return;
  const two = await generateRefinedCv(opened.contextId, second.version, "draft", one.draftId);
  expect(two).toMatchObject({ ok: true, status: "ready", charged: false });
  if (!two.ok || !two.draftId) return;
  const [twoDraft] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, two.draftId));
  expect(twoDraft?.content?.summary).toBe("Operations leader with measured delivery");
  expect(twoDraft?.content?.sections[0]?.bullets).toEqual(["Cut the backlog by 20%"]);
  expect(twoDraft?.autoBaselineId).toBe(claimed.baselineId);
  const [firstEvent] = await database.select().from(schema.cvRefinementEvents)
    .where(eq(schema.cvRefinementEvents.contextId, opened.contextId))
    .orderBy(schema.cvRefinementEvents.createdAt).limit(1);
  const removed = await resetCvRefinement(opened.contextId, second.version, firstEvent!.stableId);
  expect(removed).toMatchObject({ ok: true, version: 3 });
  if (!removed.ok) return;
  const afterOneReset = await generateRefinedCv(opened.contextId, removed.version, "draft", two.draftId);
  expect(afterOneReset).toMatchObject({ ok: true, status: "ready", charged: false });
  if (!afterOneReset.ok || !afterOneReset.draftId) return;
  const [restored] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, afterOneReset.draftId));
  expect(restored?.content?.summary).toBe(content.summary);
  expect(restored?.content?.sections[0]?.bullets).toEqual(["Cut the backlog by 20%"]);
  const resetAll = await resetCvRefinement(opened.contextId, removed.version);
  expect(resetAll).toMatchObject({ ok: true, version: 4 });
  const [selected] = await database.select().from(schema.cvApplicationContexts)
    .where(eq(schema.cvApplicationContexts.id, opened.contextId));
  expect(selected).toMatchObject({ selectedKind: "baseline", selectedId: claimed.baselineId });
  expect((await database.select().from(schema.tasks)).filter(task => task.type === "generate_cv")).toHaveLength(1);
  expect(await database.select().from(schema.creditReservations)).toHaveLength(1);
});

it("binds chained cited locks to the retained Auto source, including a re-edited summary", async () => {
  const opened = await context();
  const citedLibrary = { ...library, entries: [{ ...library.entries[0]!,
    details: "Reduced backlog by 20%\nImproved reporting cadence",
    confirmedResponsibilities: ["Reduced backlog by 20%", "Improved reporting cadence"] }] };
  await database.insert(schema.cvLibraries).values({ userId, version: 1, content: citedLibrary });
  await grantCvCredits(database, { userId, source: "admin", units: 2, externalRef: `chained-${userId}` });
  const claimed = await openOrClaimAutoCv(opened.contextId, "update");
  expect(claimed.ok, JSON.stringify(claimed)).toBe(true);
  if (!claimed.ok || !claimed.baselineId || !claimed.draftId) return;
  const content = CvContentSchema.parse({ name: "Ada Example", contact: "London",
    summary: "Reduced backlog and improved reporting", summarySources: ["entry:role:row:0"],
    sections: [{ entryId: "role", kind: "experience", heading: "Operations Manager",
      bullets: ["Reduced backlog by 20%", "Improved reporting cadence"],
      bulletSources: [["entry:role:row:0"], ["entry:role:row:1"]] }], gaps: [] });
  const targets = cvEditingTargetsFor(content, () => crypto.randomUUID());
  await database.transaction(tx => publishCvAutoBaseline(tx, { userId, baselineId: claimed.baselineId!,
    sourceDraftId: claimed.draftId!, content, librarySnapshot: citedLibrary, editingTargets: targets }));
  await database.update(schema.cvDrafts).set({ status: "ready", content, editingTargets: targets })
    .where(eq(schema.cvDrafts.id, claimed.draftId));

  const save = async (version: number, sourceKind: "baseline" | "draft", sourceId: string,
    target: { type: "bullet" | "summary"; id: string }, text: string, id?: string) => {
    const saved = await saveCvRefinement(opened.contextId, version, { sourceKind, sourceId,
      kind: "exact_wording", target, text, order: version, ...(id ? { id } : {}) });
    expect(saved).toMatchObject({ ok: true, version: version + 1 });
    if (!saved.ok) throw new Error(saved.error);
    const result = await generateRefinedCv(opened.contextId, saved.version, sourceKind, sourceId);
    expect(result).toMatchObject({ ok: true, status: "ready", charged: false });
    if (!result.ok || !result.draftId) throw new Error(JSON.stringify(result));
    return result.draftId;
  };
  const first = await save(0, "baseline", claimed.baselineId,
    { type: "bullet", id: targets.sections[0]!.bulletIds[0]! }, "Cut the backlog by 20%");
  const second = await save(1, "draft", first,
    { type: "bullet", id: targets.sections[0]!.bulletIds[1]! }, "Improved weekly reporting cadence");
  const third = await save(2, "draft", second,
    { type: "summary", id: targets.summaryId }, "Operational leader with measured delivery");
  const events = await database.select().from(schema.cvRefinementEvents)
    .where(eq(schema.cvRefinementEvents.contextId, opened.contextId));
  const summaryId = events.find(row => row.refinement.target.type === "summary")?.stableId;
  expect(summaryId).toBeTruthy();
  const fourth = await save(3, "draft", third,
    { type: "summary", id: targets.summaryId }, "Operations leader improving delivery", summaryId);
  const [edition] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, fourth));
  expect(edition?.content?.sections[0]?.bullets).toEqual([
    "Cut the backlog by 20%", "Improved weekly reporting cadence"]);
  expect(edition?.content?.summary).toBe("Operations leader improving delivery");
  expect((await database.select().from(schema.tasks)).filter(task => task.type === "generate_cv")).toHaveLength(1);
  expect(await database.select().from(schema.creditReservations)).toHaveLength(1);

  // A target newly added to a generated edition has no retained Auto anchor.
  const added = CvContentSchema.parse({ ...edition!.content!, sections: [{ ...edition!.content!.sections[0]!,
    bullets: [...edition!.content!.sections[0]!.bullets, "New manual bullet"], bulletSources: undefined }] });
  const addedTargets = { ...edition!.editingTargets!, sections: [{ ...edition!.editingTargets!.sections[0]!,
    bulletIds: [...edition!.editingTargets!.sections[0]!.bulletIds, crypto.randomUUID()] }] };
  await database.update(schema.cvDrafts).set({ content: added, editingTargets: addedTargets })
    .where(eq(schema.cvDrafts.id, fourth));
  const missingAnchor = await saveCvRefinement(opened.contextId, 4, { sourceKind: "draft", sourceId: fourth,
    kind: "exact_wording", target: { type: "bullet", id: addedTargets.sections[0]!.bulletIds[2]! },
    text: "New manual bullet", order: 4 });
  expect(missingAnchor).toMatchObject({ ok: false });
  if (!missingAnchor.ok) expect(missingAnchor.error).toMatch(/Auto source changed/i);
});

it("rebases only chosen exact anchors to the current JD and leaves a changed fact visible", async () => {
  const opened = await context();
  const sourceLibrary = { ...library, entries: [{ ...library.entries[0]!,
    details: "Reduced backlog by 20%\nImproved reporting cadence",
    confirmedResponsibilities: ["Reduced backlog by 20%", "Improved reporting cadence"] }] };
  await database.insert(schema.cvLibraries).values({ userId, version: 1, content: sourceLibrary });
  await grantCvCredits(database, { userId, source: "admin", units: 3, externalRef: `rebase-${userId}` });
  const first = await openOrClaimAutoCv(opened.contextId, "update");
  expect(first.ok, JSON.stringify(first)).toBe(true);
  if (!first.ok || !first.baselineId || !first.draftId) return;
  const oldContent = CvContentSchema.parse({ name: "Ada Example", contact: "London", summary: "Operations lead",
    sections: [{ entryId: "role", kind: "experience", heading: "Operations Manager",
      bullets: ["Reduced backlog by 20%", "Improved reporting cadence"],
      bulletSources: [["entry:role:row:0"], ["entry:role:row:1"]] }], gaps: [] });
  const oldTargets = cvEditingTargetsFor(oldContent, () => crypto.randomUUID());
  const rubric = rubricFixture(description);
  const assessmentFor = (content: typeof oldContent, source: typeof sourceLibrary, role: string) =>
    createCvAssessment({ content, description: role, library: source, rubric,
      review: reviewFixture({ rubric, cv: cvTextItems(content), claims: cvClaimItems(content),
        evidence: cvEvidenceItems(source) }), model: "test", pageCount: 1 });
  await database.transaction(tx => publishCvAutoBaseline(tx, { userId, baselineId: first.baselineId!,
    sourceDraftId: first.draftId!, content: oldContent, assessment: assessmentFor(oldContent, sourceLibrary, description),
    librarySnapshot: sourceLibrary, editingTargets: oldTargets }));
  await database.update(schema.cvDrafts).set({ status: "ready", content: oldContent,
    editingTargets: oldTargets }).where(eq(schema.cvDrafts.id, first.draftId));
  await database.update(schema.tasks).set({ status: "done" }).where(sql`${schema.tasks.payload}->>'draftId' = ${first.draftId}`);
  const firstRule = await saveCvRefinement(opened.contextId, 0, { sourceKind: "baseline",
    sourceId: first.baselineId, kind: "exact_wording",
    target: { type: "bullet", id: oldTargets.sections[0]!.bulletIds[0] },
    text: "Cut the backlog by 20%", order: 0 });
  expect(firstRule).toMatchObject({ ok: true, version: 1 });
  const secondRule = await saveCvRefinement(opened.contextId, 1, { sourceKind: "baseline",
    sourceId: first.baselineId, kind: "exact_wording",
    target: { type: "bullet", id: oldTargets.sections[0]!.bulletIds[1] },
    text: "Improved reporting each week", order: 1 });
  expect(secondRule).toMatchObject({ ok: true, version: 2 });
  const updatedRole = `${description} Maintain the same operations evidence while improving the team.`;
  const changed = await updateCvApplicationDescription(opened.contextId, opened.descriptionVersionId, updatedRole);
  expect(changed.ok, JSON.stringify(changed)).toBe(true);
  const nextLibrary = { ...sourceLibrary, entries: [{ ...sourceLibrary.entries[0]!,
    details: "Reduced backlog by 20%\nImproved reporting daily",
    confirmedResponsibilities: ["Reduced backlog by 20%", "Improved reporting daily"] }] };
  await database.insert(schema.cvLibraries).values({ userId, version: 2, content: nextLibrary });
  const second = await openOrClaimAutoCv(opened.contextId, "update");
  expect(second.ok, JSON.stringify(second)).toBe(true);
  if (!second.ok || !second.baselineId || !second.draftId) return;
  const nextContent = CvContentSchema.parse({ ...oldContent, sections: [{ ...oldContent.sections[0]!,
    bullets: ["Improved reporting daily", "Reduced backlog by 20%"],
    bulletSources: [["entry:role:row:1"], ["entry:role:row:0"]] }] });
  const nextTargets = cvEditingTargetsFor(nextContent, () => crypto.randomUUID());
  await database.transaction(tx => publishCvAutoBaseline(tx, { userId, baselineId: second.baselineId!,
    sourceDraftId: second.draftId!, content: nextContent,
    assessment: assessmentFor(nextContent, nextLibrary, updatedRole),
    librarySnapshot: nextLibrary, editingTargets: nextTargets }));
  await database.update(schema.cvDrafts).set({ status: "ready", content: nextContent,
    editingTargets: nextTargets }).where(eq(schema.cvDrafts.id, second.draftId));
  const preview = await previewCvRefinementRebase(opened.contextId, 2, first.baselineId, second.baselineId);
  expect(preview.ok, JSON.stringify(preview)).toBe(true);
  if (!preview.ok) return;
  expect(preview.items).toMatchObject([{ status: "compatible", target: { type: "bullet",
    id: nextTargets.sections[0]!.bulletIds[1] } }, { status: "conflict", reason: "changed_source" }]);
  const ownerSession = session;
  const foreign = await signInTestUser(database, process.env.SESSION_SECRET!, "foreign@example.com");
  session = foreign.cookie;
  expect(await previewCvRefinementRebase(opened.contextId, 2, first.baselineId, second.baselineId))
    .toMatchObject({ ok: false });
  expect(await applyCvRefinementRebase(opened.contextId, 2, first.baselineId, second.baselineId,
    preview.previewKey, [preview.items[0]!.id])).toMatchObject({ ok: false });
  session = ownerSession;
  const compatibleId = preview.items[0]!.id;
  const refused = await applyCvRefinementRebase(opened.contextId, 2, first.baselineId, second.baselineId,
    preview.previewKey, [preview.items[1]!.id]);
  expect(refused).toMatchObject({ ok: false });
  const stale = await applyCvRefinementRebase(opened.contextId, 2, first.baselineId, second.baselineId,
    "0".repeat(64), [compatibleId]);
  expect(stale).toMatchObject({ ok: false });
  const applied = await applyCvRefinementRebase(opened.contextId, 2, first.baselineId, second.baselineId,
    preview.previewKey, [compatibleId]);
  expect(applied).toMatchObject({ ok: true, version: 3, rebasedIds: [compatibleId],
    conflicts: [{ id: preview.items[1]!.id, reason: "changed_source" }] });
  const later = await previewCvRefinementRebase(opened.contextId, 3, first.baselineId, second.baselineId);
  expect(later.ok).toBe(true);
  if (later.ok) expect(later.items).toMatchObject([{ id: compatibleId, status: "current" },
    { id: preview.items[1]!.id, status: "conflict", reason: "changed_source" }]);
  expect((await database.select().from(schema.tasks)).filter(task => task.type === "generate_cv")).toHaveLength(2);
  expect(await database.select().from(schema.creditReservations)).toHaveLength(2);
});
