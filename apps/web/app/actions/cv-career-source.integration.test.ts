import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, grantCvCredits, lockAccountScoreInput, saveCareerChange, saveCareerChangeIn, ensureCareerBackfill,
  schema, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { createTestDb } from "@/test/db";
import { signInTestUser } from "@/test/auth";
import { createCvApplicationContext, openOrClaimAutoCv, readAutoCvSourceChoices, retryFailedAutoCv } from "./cv-editing";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let userId: string;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => session ? { value: session } : undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
const fields = (text: string) => ({ title: "Service redesign", originalNarrative: text,
  dates: { start: "2024-01", end: null, current: true }, arrangement: "contract" as const,
  publicLabel: null, confidential: false, industries: ["Software"] });

beforeAll(async () => {
  const client = createTestDb(); database = client.db; pool = client.pool;
  await runMigrations(database); process.env.SESSION_SECRET = "career-cv-test-secret";
});
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate users restart identity cascade`);
  const signed = await signInTestUser(database, process.env.SESSION_SECRET!);
  session = signed.cookie; userId = signed.user.id;
  await database.update(schema.users).set({ name: "Ada Example" }).where(eq(schema.users.id, userId));
  await grantCvCredits(database, { userId, source: "admin", units: 4, externalRef: userId });
});
async function setup() {
  const recordId = crypto.randomUUID();
  await saveCareerChange(database, userId, { expectedRevision: 0, requestKey: crypto.randomUUID(),
    operations: [{ type: "create_record", id: recordId, kind: "project", fields: fields("Reduced backlog by 20%") }] });
  const opened = await createCvApplicationContext({ requestKey: `paste:${crypto.randomUUID()}`,
    companyName: "Acme", jobTitle: "Operations Lead",
    description: "Lead the operations team, improve service quality, and deliver measurable outcomes across the organisation." });
  if (!opened.ok) throw new Error(opened.error);
  return { recordId, contextId: opened.contextId };
}

it("builds from directly saved career facts without a legacy Library or proof confirmation, and reuses concurrent requests", async () => {
  const { recordId, contextId } = await setup();
  const results = await Promise.all([openOrClaimAutoCv(contextId, "update"), openOrClaimAutoCv(contextId, "update")]);
  expect(results.every(result => result.ok), JSON.stringify(results)).toBe(true);
  expect(results.filter(result => result.ok && result.charged)).toHaveLength(1);
  const drafts = await database.select().from(schema.cvDrafts);
  expect(drafts).toHaveLength(1);
  expect(drafts[0]?.librarySnapshot.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: recordId, details: "Reduced backlog by 20%" }),
  ]));
  expect(drafts[0]?.careerSourceMap?.[`entry:${recordId}:row:0`]).toMatchObject({ recordId, recordRevision: 1 });
  expect(await database.select().from(schema.creditReservations)).toHaveLength(1);
});

it("creates a new immutable Auto input after a factual edit while retaining the first build's facts", async () => {
  const { recordId, contextId } = await setup();
  const first = await openOrClaimAutoCv(contextId, "update");
  expect(first.ok).toBe(true);
  const [original] = await database.select().from(schema.cvDrafts);
  const before = JSON.stringify(original!.librarySnapshot);
  await saveCareerChange(database, userId, { expectedRevision: 1, requestKey: crypto.randomUUID(),
    operations: [{ type: "edit_record", id: recordId, expectedRevision: 1, fields: fields("Reduced backlog by 35%") }] });
  const next = await openOrClaimAutoCv(contextId, "update");
  expect(next).toMatchObject({ ok: true, charged: true });
  if (!next.ok || !next.draftId) return;
  const [saved] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, next.draftId));
  const [unchanged] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, original!.id));
  expect(JSON.stringify(unchanged!.librarySnapshot)).toBe(before);
  expect(saved!.careerVersion).toBeGreaterThan(original!.careerVersion!);
  expect(saved!.librarySnapshot.entries.find(entry => entry.id === recordId)?.details).toBe("Reduced backlog by 35%");
  const baselines = await database.select().from(schema.cvAutoBaselines);
  expect(new Set(baselines.map(row => row.inputKey)).size).toBe(2);
});

it("waits for a concurrent factual save before freezing its build snapshot", async () => {
  const { recordId, contextId } = await setup();
  let build: ReturnType<typeof openOrClaimAutoCv> | undefined;
  await database.transaction(async tx => {
    await lockAccountScoreInput(tx as unknown as Db, userId, "exclusive");
    await saveCareerChangeIn(tx, userId, { expectedRevision: 1, requestKey: crypto.randomUUID(),
      operations: [{ type: "edit_record", id: recordId, expectedRevision: 1, fields: fields("Reduced backlog by 45%") }] });
    build = openOrClaimAutoCv(contextId, "update");
    // The build can start reading, but cannot claim a mixed snapshot before this save commits.
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  const result = await build!;
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, charged: true });
  const [saved] = await database.select().from(schema.cvDrafts);
  expect(saved!.librarySnapshot.entries.find(entry => entry.id === recordId)?.details).toBe("Reduced backlog by 45%");
  expect(saved!.careerSourceMap?.[`entry:${recordId}:row:0`]).toMatchObject({ recordRevision: 2 });
});

it("uses an edited imported story as a user fact without relabelling the original source", async () => {
  await database.insert(schema.cvLibraries).values({ userId, version: 1, content: {
    name: "Ada Example", contact: "London", profile: "", entries: [{ id: "imported-role",
      kind: "experience", heading: "Operations Lead", details: "Managed customer support",
      confirmedResponsibilities: ["Managed customer support"] }],
  } });
  await ensureCareerBackfill(database, userId);
  const [record] = await database.select().from(schema.careerRecords)
    .where(sql`${schema.careerRecords.userId} = ${userId}::uuid and ${schema.careerRecords.kind} = 'role'`);
  const [head] = await database.select().from(schema.careerHeads).where(eq(schema.careerHeads.userId, userId));
  await saveCareerChange(database, userId, { expectedRevision: head!.revision, requestKey: crypto.randomUUID(),
    operations: [{ type: "edit_record", id: record!.id, expectedRevision: record!.revision,
      fields: { ...record!.fields, title: "Senior Operations Lead" } }] });
  let authored = await database.select().from(schema.careerAssertions).where(sql`${schema.careerAssertions.userId} = ${userId}::uuid
    and ${schema.careerAssertions.provenance}->>'kind' = 'direct_user'`);
  expect(authored).toHaveLength(0);
  await saveCareerChange(database, userId, { expectedRevision: head!.revision + 1, requestKey: crypto.randomUUID(),
    operations: [{ type: "edit_record", id: record!.id, expectedRevision: record!.revision + 1,
      fields: { ...record!.fields, title: "Senior Operations Lead", originalNarrative: "Reduced service waiting times by 30%" } }] });
  authored = await database.select().from(schema.careerAssertions).where(sql`${schema.careerAssertions.userId} = ${userId}::uuid
    and ${schema.careerAssertions.provenance}->>'kind' = 'direct_user'`);
  expect(authored).toHaveLength(1);
  expect(authored[0]).toMatchObject({ status: "usable", text: "Reduced service waiting times by 30%" });
  const [savedRecord] = await database.select().from(schema.careerRecords).where(eq(schema.careerRecords.id, record!.id));
  expect(savedRecord!.provenance.kind).toBe("legacy_saved");
  const opened = await createCvApplicationContext({ requestKey: `paste:${crypto.randomUUID()}`,
    companyName: "Acme", jobTitle: "Operations Lead",
    description: "Lead the operations team, improve service quality, and deliver measurable outcomes across the organisation." });
  if (!opened.ok) throw new Error(opened.error);
  const built = await openOrClaimAutoCv(opened.contextId, "update");
  expect(built).toMatchObject({ ok: true, charged: true });
  const [draft] = await database.select().from(schema.cvDrafts);
  expect(draft!.librarySnapshot.entries.find(entry => entry.id === record!.id)?.details).toContain(authored[0]!.text);
  expect(draft!.librarySnapshot.entries.find(entry => entry.id === record!.id)?.details).toContain("Managed customer support");
});

async function conflictedSetup(onlyDisputed = false) {
  const { recordId, contextId } = await setup();
  const firstId = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  const context = { attribute: "team size", scope: "operations", period: "2025", value: "5" };
  const saved = await saveCareerChange(database, userId, { expectedRevision: 1, requestKey: crypto.randomUUID(), operations: [
    ...(onlyDisputed ? [{ type: "edit_record" as const, id: recordId, expectedRevision: 1, fields: fields("") }] : []),
    { type: "add_assertion", id: firstId, subjectId: recordId, text: "Led a team of 5", publicText: null, facets: [], context },
    { type: "add_assertion", id: secondId, subjectId: recordId, text: "Led a team of 10", publicText: null,
      facets: [], context: { ...context, value: "10" } },
  ] });
  if (!saved.ok) throw new Error(saved.error);
  expect(saved.conflicts).toHaveLength(1);
  const read = await readAutoCvSourceChoices(contextId);
  if (!read.ok) throw new Error(read.error);
  expect(read.conflicts).toHaveLength(1);
  return { recordId, contextId, firstId, secondId, context, group: read.conflicts[0]! };
}

it("keeps pending conflicts advisory while Auto builds from unaffected details", async () => {
  const { contextId, recordId } = await conflictedSetup();
  expect(await database.select().from(schema.creditReservations)).toHaveLength(0);
  const result = await openOrClaimAutoCv(contextId, "update");
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, charged: true, sourceReview: [expect.anything()] });
  const [draft] = await database.select().from(schema.cvDrafts);
  expect(draft?.librarySnapshot.entries.find(entry => entry.id === recordId)?.details).toBe("Reduced backlog by 20%");
  // Diagnostics are for the person. Raw disputed prose must not enter the model through metadata.
  expect(JSON.stringify(draft?.librarySnapshot)).not.toContain("Led a team of");
  const events = await database.execute(sql`select id from career_review_events where user_id = ${userId}::uuid`);
  expect(events.rows).toHaveLength(0);
});

it("offers a CV-only choice when every fact is disputed and pins it through duplicate requests and retry", async () => {
  const { contextId, firstId, secondId, group } = await conflictedSetup(true);
  const empty = await openOrClaimAutoCv(contextId, "update");
  expect(empty).toMatchObject({ ok: false, error: expect.stringContaining("continue in Manual"), sourceReview: [expect.anything()] });
  expect(await database.select().from(schema.creditReservations)).toHaveLength(0);
  expect(await database.select().from(schema.cvAutoBaselines)).toHaveLength(0);
  const choices = [{ groupKey: group.groupKey, fingerprint: group.fingerprint, chosenAssertionId: firstId }];
  const result = await openOrClaimAutoCv(contextId, "update", choices);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, charged: true });
  if (!result.ok || !result.draftId || !result.baselineId) return;
  const duplicate = await openOrClaimAutoCv(contextId, "update", choices);
  expect(duplicate).toMatchObject({ ok: true, charged: false, draftId: result.draftId });
  const [draft] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, result.draftId));
  expect(draft?.librarySnapshot.careerProjection?.conflictChoices).toEqual(choices);
  expect(JSON.stringify(draft?.librarySnapshot)).toContain("Led a team of 5");
  expect(JSON.stringify(draft?.librarySnapshot)).not.toContain("Led a team of 10");
  const second = await openOrClaimAutoCv(contextId, "update", [{ ...choices[0]!, chosenAssertionId: secondId }]);
  expect(second).toMatchObject({ ok: true, charged: true });
  expect(second.ok && second.baselineId).not.toBe(result.baselineId);
  await database.update(schema.tasks).set({ status: "done" });
  await database.update(schema.cvDrafts).set({ status: "failed" }).where(eq(schema.cvDrafts.id, draft!.id));
  await database.update(schema.cvAutoBaselines).set({ status: "failed" }).where(eq(schema.cvAutoBaselines.id, result.baselineId));
  const retried = await retryFailedAutoCv(contextId, result.baselineId);
  expect(retried, JSON.stringify(retried)).toMatchObject({ ok: true, draftId: result.draftId });
  const [again] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft!.id));
  expect(again?.librarySnapshot).toEqual(draft?.librarySnapshot);
  const events = await database.execute(sql`select id from career_review_events where user_id = ${userId}::uuid`);
  expect(events.rows).toHaveLength(0);
});

it("refuses stale or foreign CV-only choices before reserving a credit", async () => {
  const { contextId, firstId, secondId, group, context } = await conflictedSetup();
  const choice = { groupKey: group.groupKey, fingerprint: group.fingerprint, chosenAssertionId: firstId };
  const unknown = await openOrClaimAutoCv(contextId, "update", [{ ...choice, chosenAssertionId: crypto.randomUUID() }]);
  expect(unknown.ok).toBe(false);
  await saveCareerChange(database, userId, { expectedRevision: 2, requestKey: crypto.randomUUID(), operations: [
    { type: "edit_assertion", id: secondId, expectedRevision: 1, text: "Led a team of 12", publicText: null,
      facets: [], context: { ...context, value: "12" } },
  ] });
  const stale = await openOrClaimAutoCv(contextId, "update", [choice]);
  expect(stale).toMatchObject({ ok: false, error: expect.stringMatching(/changed|reload|refresh/i) });
  expect(await database.select().from(schema.creditReservations)).toHaveLength(0);
  expect(await database.select().from(schema.cvDrafts)).toHaveLength(0);
  const other = await signInTestUser(database, process.env.SESSION_SECRET!, "other-career@example.com");
  session = other.cookie;
  expect(await readAutoCvSourceChoices(contextId)).toMatchObject({ ok: false });
});
