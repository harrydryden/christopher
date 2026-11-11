import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, grantCvCredits, publishCvAutoBaseline, schema, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { cvEditingTargetsFor } from "@col/core/cv-editing-modes";
import { cvTailoringEvidence } from "@col/core/cv-tailoring";
import { createTestDb } from "@/test/db";
import { signInTestUser } from "@/test/auth";

let database: Db, pool: ReturnType<typeof createDb>["pool"], session: string | undefined, userId: string;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => session ? { value: session } : undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { useCvSkillSuggestions } from "./cv-skills";
import { openOrClaimAutoCv, resetCvRefinement, saveAndUpdateCvExactRefinement } from "./cv-editing";

beforeAll(async () => {
  const client = createTestDb(); database = client.db; pool = client.pool;
  await runMigrations(database); process.env.SESSION_SECRET = "cv-mode-skills-test-secret";
});
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate users, tasks restart identity cascade`);
  const signed = await signInTestUser(database, process.env.SESSION_SECRET!);
  session = signed.cookie; userId = signed.user.id;
});

async function fixture() {
  const content = { name: "Ada", contact: "London", summary: "Analyst", gaps: [], sections: [
    { entryId: "role", kind: "experience" as const, heading: "Analyst", bullets: ["Used Excel to report results"],
      bulletSources: [["entry:role:row:0"]] }] };
  const library = { name: "Ada", contact: "London", profile: "",
    employment: [{ id: "job", company: "Acme", jobTitle: "Analyst", startDate: "", endDate: "", current: true }],
    entries: [
    { id: "role", kind: "experience" as const, heading: "Analyst", employmentId: "job",
      details: "Used Excel to report results", confirmedResponsibilities: ["Used Excel to report results"] }] };
  const targets = cvEditingTargetsFor(content, () => crypto.randomUUID());
  await database.insert(schema.cvLibraries).values({ userId, version: 1, content: library });
  const [context] = await database.insert(schema.cvApplicationContexts).values({ userId,
    requestKey: `paste:${crypto.randomUUID()}`, companyName: "Acme", jobTitle: "Analyst" }).returning();
  const [description] = await database.insert(schema.cvContextDescriptions).values({ userId,
    contextId: context!.id, version: 1, text: "Use Excel to improve reporting." }).returning();
  const [draft] = await database.insert(schema.cvDrafts).values({ userId, contextId: context!.id,
    descriptionVersionId: description!.id, editingMode: "manual", revision: 1, status: "ready", content,
    editingTargets: targets, librarySnapshot: library, libraryVersion: 1, model: "manual",
    companyName: "Acme", jobTitle: "Analyst", jobDescription: description!.text }).returning();
  await database.update(schema.cvApplicationContexts).set({ currentDescriptionVersionId: description!.id,
    selectedKind: "draft", selectedId: draft!.id }).where(eq(schema.cvApplicationContexts.id, context!.id));
  const suggestionId = crypto.randomUUID();
  const [run] = await database.insert(schema.cvSkillSuggestionRuns).values({ userId, draftId: draft!.id,
    libraryVersion: 1, inputHash: "source", status: "ready", suggestions: [{ id: suggestionId,
      category: "Data tools", label: "Excel", sourceId: "entry:role:row:0",
      evidenceQuote: "Used Excel", roleQuote: "Excel" }] }).returning();
  return { context: context!, draft: draft!, run: run!, suggestionId };
}

it("uses one selected suggestion on a ready Manual edition, retaining derived provenance and replay fencing", async () => {
  const { context, draft, run, suggestionId } = await fixture();
  const key = crypto.randomUUID();
  expect({ contextId: context.id, draftId: draft.id, runId: run.id, key, suggestionId })
    .toMatchObject({ contextId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      draftId: expect.stringMatching(/^[0-9a-f-]{36}$/), runId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  const first = await useCvSkillSuggestions(context.id, draft.id, run.id, 1, 0, [suggestionId], key);
  expect(first, JSON.stringify(first)).toMatchObject({ ok: true, charged: false, version: 1 });
  if (!first.ok) return;
  const [child] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, first.draftId));
  expect(child?.editingMode).toBe("manual");
  expect(child?.content?.sections.flatMap(section => section.skillItems ?? [])).toContain("Excel");
  expect(cvTailoringEvidence(child!.librarySnapshot!).some(row => row.text === "Excel")).toBe(false);
  expect((await database.select().from(schema.careerAssertions).where(eq(schema.careerAssertions.userId, userId)))
    .some(row => row.text === "Excel" && row.provenance.kind === "accepted_suggestion" &&
      row.provenance.sourceId === "entry:role:row:0")).toBe(true);
  expect(await useCvSkillSuggestions(context.id, draft.id, run.id, 1, 0, [suggestionId], key)).toMatchObject(first);
  expect(await useCvSkillSuggestions(context.id, draft.id, run.id, 1, 0, [suggestionId], crypto.randomUUID()))
    .toMatchObject({ ok: false });
  expect(await database.select().from(schema.cvDrafts)).toHaveLength(2);
  expect(await database.select().from(schema.tasks)).toHaveLength(1); // Recommendation rescore only.
});

it("rejects another account before changing the Library or CV", async () => {
  const { context, draft, run, suggestionId } = await fixture();
  const other = await signInTestUser(database, process.env.SESSION_SECRET!, "other-skill-mode@example.com");
  session = other.cookie;
  expect(await useCvSkillSuggestions(context.id, draft.id, run.id, 1, 0,
    [suggestionId], crypto.randomUUID())).toMatchObject({ ok: false });
  expect(await database.select().from(schema.cvLibraries)).toHaveLength(1);
  expect(await database.select().from(schema.cvDrafts)).toHaveLength(1);
});

it("keeps an Auto-descended skill choice in its overlay while the retained Auto result stays immutable", async () => {
  const seed = await fixture();
  await grantCvCredits(database, { userId, source: "admin", units: 2, externalRef: `skills-auto-${userId}` });
  const claimed = await openOrClaimAutoCv(seed.context.id, "update");
  expect(claimed).toMatchObject({ ok: true });
  if (!claimed.ok || !claimed.draftId || !claimed.baselineId) return;
  const content = seed.draft.content!;
  const targets = seed.draft.editingTargets!;
  const library = seed.draft.librarySnapshot!;
  await database.transaction(tx => publishCvAutoBaseline(tx, { userId,
    baselineId: claimed.baselineId!, sourceDraftId: claimed.draftId!, content, librarySnapshot: library,
    editingTargets: targets }));
  await database.update(schema.cvDrafts).set({ status: "ready", content, editingTargets: targets })
    .where(eq(schema.cvDrafts.id, claimed.draftId));
  await database.update(schema.tasks).set({ status: "done" }).where(eq(schema.tasks.type, "generate_cv"));
  const [producer] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, claimed.draftId));
  const suggestionId = crypto.randomUUID();
  const [run] = await database.insert(schema.cvSkillSuggestionRuns).values({ userId, draftId: producer!.id,
    libraryVersion: 1, inputHash: "source", status: "ready", suggestions: [{ id: suggestionId,
      category: "Data tools", label: "Excel", sourceId: "entry:role:row:0",
      evidenceQuote: "Used Excel", roleQuote: "Excel" }] }).returning();
  const result = await useCvSkillSuggestions(seed.context.id, producer!.id, run!.id,
    producer!.revision, 0, [suggestionId], crypto.randomUUID());
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, charged: false, version: 1 });
  if (!result.ok) return;
  const [child] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, result.draftId));
  expect(child?.autoBaselineId).toBe(claimed.baselineId);
  expect(child?.refinementSnapshot?.at(-1)?.structured?.kind).toBe("skill_selection");
  expect(child?.editingTargets?.sections.at(-1)?.skillIds).toHaveLength(1);
  const exact = await saveAndUpdateCvExactRefinement(seed.context.id, result.version,
    { kind: "draft", id: child!.id, revision: child!.revision }, {
      target: { type: "skill", id: child!.editingTargets!.sections.at(-1)!.skillIds[0]! },
      text: "Excel reporting", order: 1, requestKey: crypto.randomUUID(),
    });
  expect(exact, JSON.stringify(exact)).toMatchObject({ ok: true, charged: false, version: 2 });
  if (!exact.ok) return;
  const [edited] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, exact.draftId));
  expect(edited?.content?.sections.at(-1)?.skillItems).toEqual(["Excel reporting"]);
  expect((await database.select().from(schema.cvAutoBaselines).where(eq(schema.cvAutoBaselines.id, claimed.baselineId)))[0]?.content)
    .toEqual(content);
  expect(await resetCvRefinement(seed.context.id, 2, child!.refinementSnapshot!.at(-1)!.id))
    .toMatchObject({ ok: true, version: 3 });
});
