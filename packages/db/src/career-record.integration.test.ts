import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { CareerChangeResult, CareerOperation, CareerRecordFields } from "@col/core/career-record";
import { CvLibrarySchema } from "@col/core/cv";
import { createDb } from "./client";
import { runMigrations } from "./migrate";
import { getCareerWorkspace, saveCareerChange, undoCareerChange } from "./career-record";
import { getCareerRecommendationProfile } from "./career-recommendation-profile";
import { careerCvEvidence } from "./career-cv";
import { careerAssertions, careerChanges, careerRecords, cvLibraries, users } from "./schema";

const connection = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/col_test", { max: 3 });
const db = connection.db;
let owner: string;
let stranger: string;
const fields = (title: string): CareerRecordFields => ({ title, originalNarrative: "", dates: { start: null, end: null, current: false },
  arrangement: null, publicLabel: null, confidential: false, industries: [] });
function success(result: CareerChangeResult) {
  if (!result.ok) throw new Error(result.error);
  return result;
}
const save = async (operations: CareerOperation[], expectedRevision = 0, requestKey = randomUUID(), userId = owner) =>
  success(await saveCareerChange(db, userId, { expectedRevision, requestKey, operations }));
const record = (id: string, title: string): CareerOperation => ({ type: "create_record", id, kind: "project", fields: fields(title) });
const assertion = (id: string, subjectId: string, text: string): CareerOperation => ({ type: "add_assertion", id, subjectId,
  text, publicText: null, facets: [], context: null });
const link = (id: string, fromId: string, toId: string): CareerOperation => ({ type: "create_link", id, fromId, toId,
  kind: "part_of", confidential: false, publicLabel: null });

beforeAll(async () => { await runMigrations(db); });
beforeEach(async () => {
  await db.execute(sql`truncate users restart identity cascade`);
  const accounts = await db.insert(users).values([{ email: "career-owner@example.test", name: "Career owner" }, { email: "career-other@example.test", name: "Other owner" }]).returning();
  owner = accounts[0]!.id; stranger = accounts[1]!.id;
});
afterAll(async () => { await connection.pool.end(); });

describe("career changes retain identity and recovery across real database transactions", () => {
  it("durably saves an unnamed account's first story without inventing a name or requiring a CV", async () => {
    await db.update(users).set({ name: null }).where(eq(users.id, owner));
    const id = randomUUID();
    const saved = await save([{ ...record(id, "First project"), fields: { ...fields("First project"),
      originalNarrative: "Delivered a community project" } } as CareerOperation]);
    expect((await getCareerWorkspace(db, owner, { recordId: id })).selected?.record.fields.originalNarrative)
      .toBe("Delivered a community project");
    await expect(careerCvEvidence(db, owner, saved.revision)).rejects.toThrow("name");
    expect(await db.select().from(careerChanges)).toHaveLength(1);
    expect(await db.select().from(cvLibraries)).toHaveLength(0);
  });

  it("commits a repeated intent once and rejects key reuse or foreign records", async () => {
    const id = randomUUID(), key = randomUUID();
    const first = await save([record(id, "Client delivery")], 0, key);
    const repeated = await save([record(id, "Client delivery")], 0, key);
    expect(repeated.changeId).toBe(first.changeId);
    expect(await db.select().from(careerChanges)).toHaveLength(1);
    await expect(save([record(id, "Different intent")], 0, key)).rejects.toThrow();
    await expect(save([assertion(randomUUID(), id, "A foreign fact")], 0, randomUUID(), stranger)).rejects.toThrow();
    expect(await db.select().from(careerAssertions)).toHaveLength(0);
  });

  it("preserves concurrent changes to different records and rejects a stale edit of the same record", async () => {
    const a = randomUUID(), b = randomUUID();
    const initial = await save([record(a, "First project"), record(b, "Second project")]);
    await Promise.all([
      save([{ type: "edit_record", id: a, expectedRevision: 1, fields: fields("First revised") }], initial.revision),
      save([{ type: "edit_record", id: b, expectedRevision: 1, fields: fields("Second revised") }], initial.revision),
    ]);
    await expect(save([{ type: "edit_record", id: a, expectedRevision: 1, fields: fields("Stale overwrite") }], initial.revision)).rejects.toThrow();
    expect((await db.select().from(careerRecords)).map(row => row.fields.title).sort()).toEqual(["First revised", "Second revised"]);
  });

  it("does not hide newer facts when undoing the creation of their record", async () => {
    const id = randomUUID(), factId = randomUUID();
    const created = await save([record(id, "Programme")]);
    const added = await save([assertion(factId, id, "Delivered the next phase")], created.revision);
    await expect(undoCareerChange(db, owner, { changeId: created.changeId, expectedRevision: added.revision, requestKey: randomUUID() })).rejects.toThrow();
    const view = await getCareerWorkspace(db, owner, { recordId: id });
    expect(view.selected?.record.archived).toBe(false);
    expect(view.selected?.assertions.map(row => row.id)).toContain(factId);
  });

  it("does not restore a removed relationship when newer relationships would make a cycle", async () => {
    const a = randomUUID(), b = randomUUID(), ab = randomUUID();
    await save([record(a, "Programme"), record(b, "Workstream"), link(ab, a, b)]);
    const removed = await save([{ type: "remove_link", id: ab, expectedRevision: 1 }]);
    const reversed = await save([link(randomUUID(), b, a)]);
    await expect(undoCareerChange(db, owner, { changeId: removed.changeId, expectedRevision: reversed.revision, requestKey: randomUUID() })).rejects.toThrow();
  });

  it("never promotes a model proposal through retract and restore", async () => {
    const id = randomUUID(), factId = randomUUID();
    await save([record(id, "Programme")]);
    await db.insert(careerAssertions).values({ id: factId, userId: owner, subjectId: id, revision: 1, text: "Unsubstantiated suggestion",
      publicText: null, facets: ["skill"], status: "proposed", provenance: { kind: "model", sourceId: null, quote: null,
        originalText: "Unsubstantiated suggestion", captureContext: "test proposal" } });
    await save([{ type: "retract_assertion", id: factId, expectedRevision: 1, retracted: true }]);
    await save([{ type: "retract_assertion", id: factId, expectedRevision: 2, retracted: false }]);
    const [row] = await db.select().from(careerAssertions).where(eq(careerAssertions.id, factId));
    expect(row?.status).toBe("proposed");
    expect(await getCareerRecommendationProfile(db, owner)).toBeNull();
  });

  it("shows perspectives and factual edit history on the related record", async () => {
    const id = randomUUID(), factId = randomUUID(), perspectiveId = randomUUID();
    await save([record(id, "Delivery")]);
    const added = await save([assertion(factId, id, "Led six people")]);
    const changed = await save([{ type: "edit_assertion", id: factId, expectedRevision: 1, text: "Led six direct reports", facets: ["responsibility"], context: null }]);
    await save([{ type: "save_perspective", id: perspectiveId, expectedRevision: 0, label: "Leadership", note: "Team leadership", assertionIds: [factId] }]);
    const view = await getCareerWorkspace(db, owner, { recordId: id });
    expect(view.selected?.perspectives.map(row => row.id)).toEqual([perspectiveId]);
    expect(view.selected?.changes.map(row => row.id)).toEqual(expect.arrayContaining([added.changeId, changed.changeId]));
  });

  it("pages tied timestamps without losing records and can open an older selected record", async () => {
    const ids = Array.from({ length: 35 }, () => randomUUID());
    for (let offset = 0; offset < ids.length; offset += 20) await save(ids.slice(offset, offset + 20).map((id, index) => record(id, `Project ${offset + index}`)));
    await db.update(careerRecords).set({ updatedAt: new Date("2026-11-01T12:00:00Z") }).where(eq(careerRecords.userId, owner));
    const first = await getCareerWorkspace(db, owner);
    expect(first.nextCursor).not.toBeNull();
    const second = await getCareerWorkspace(db, owner, { cursor: first.nextCursor! });
    expect(new Set([...first.records, ...second.records].map(row => row.id)).size).toBe(35);
    const selected = await getCareerWorkspace(db, owner, { recordId: second.records[0]!.id });
    expect(selected.selected?.record.id).toBe(second.records[0]!.id);
  });

  it("keeps different scopes compatible, flags equal-scope disagreement and ignores archived records", async () => {
    const id = randomUUID();
    await save([record(id, "Leadership")]);
    const context = { attribute: "team size", scope: "direct reports", period: "2024", value: "6" };
    await save([{ ...assertion(randomUUID(), id, "Six direct reports"), context } as CareerOperation,
      { ...assertion(randomUUID(), id, "Twenty programme participants"), context: { ...context, scope: "programme", value: "20" } } as CareerOperation]);
    expect((await getCareerWorkspace(db, owner)).conflicts).toHaveLength(0);
    await save([{ ...assertion(randomUUID(), id, "Eight direct reports"), context: { ...context, value: "8" } } as CareerOperation]);
    expect((await getCareerWorkspace(db, owner)).conflicts.length).toBeGreaterThan(0);
    await save([{ type: "archive_record", id, expectedRevision: 1, archived: true }]);
    expect((await getCareerWorkspace(db, owner)).conflicts).toHaveLength(0);
  });

  it("recommends from existing saved skills before the first Experience visit without rewriting legacy data", async () => {
    const content = CvLibrarySchema.parse({ name: "Career owner", contact: "London", profile: "Delivery professional", entries: [
      { id: "skills", kind: "skill", heading: "Delivery", details: "Programme management\nService improvement" },
      { id: "retired", kind: "experience", status: "inactive", heading: "Old role · Former employer · 2010–2012", details: "Old private evidence" },
    ] });
    await db.insert(cvLibraries).values({ userId: owner, version: 1, content });
    const first = await getCareerRecommendationProfile(db, owner);
    expect(first?.skills).toEqual(expect.arrayContaining(["Programme management", "Service improvement"]));
    expect(first?.roles.some(title => title.includes("Old role"))).toBe(false);
    const second = await getCareerRecommendationProfile(db, owner);
    expect(second).toEqual(first);
    expect(await db.select({ version: cvLibraries.version, content: cvLibraries.content }).from(cvLibraries)).toEqual([{ version: 1, content }]);
    expect(await db.select().from(careerChanges)).toHaveLength(1);
    expect(await getCareerRecommendationProfile(db, stranger)).toBeNull();
    const projection = await careerCvEvidence(db, owner, first!.version);
    expect(projection.library.entries.find(row => row.kind === "skill")?.skillItems).toEqual(expect.arrayContaining(["Programme management", "Service improvement"]));
  });

  it("retains original narrative alongside new detail and keeps historical source identity after edits", async () => {
    const id = randomUUID(), a = randomUUID(), b = randomUUID();
    const original = await save([{ ...record(id, "Delivery"), fields: { ...fields("Delivery"), originalNarrative: "Started a weekly service review." } } as CareerOperation,
      assertion(a, id, "Reduced delays"), assertion(b, id, "Coached the team")]);
    const before = await careerCvEvidence(db, owner, original.revision);
    expect(before.library.entries[0]?.details).toContain("Started a weekly service review.");
    expect(Object.values(before.sourceMap).map(ref => ref.assertionId)).toContain(b);
    const updated = await save([{ type: "edit_assertion", id: a, expectedRevision: 1, text: "Reduced handover delays", facets: [], context: null },
      assertion(randomUUID(), id, "Added a different perspective")]);
    const after = await careerCvEvidence(db, owner, updated.revision);
    const bRef = Object.values(after.sourceMap).find(ref => ref.assertionId === b);
    expect(bRef).toMatchObject({ recordId: id, assertionRevision: 1 });
    expect(Object.values(after.sourceMap).find(ref => ref.assertionId === a)?.assertionRevision).toBe(2);
    expect(await careerCvEvidence(db, owner, original.revision)).toEqual(before);
  });

  it("uses only explicit public wording for confidential work and excludes it from recommendations", async () => {
    const id = randomUUID(), factId = randomUUID();
    const saved = await save([{ ...record(id, "Secret client turnaround"), fields: { ...fields("Secret client turnaround"),
      confidential: true, publicLabel: "Healthcare service project", originalNarrative: "Secret client internal figures" } } as CareerOperation,
      { ...assertion(factId, id, "Secret client revenue rose by 20 percent"), publicText: "Improved the service handover", facets: ["skill"] } as CareerOperation]);
    const projection = await careerCvEvidence(db, owner, saved.revision);
    expect(JSON.stringify(projection)).not.toContain("Secret client");
    expect(projection.library.entries[0]?.heading).toBe("Healthcare service project");
    expect(projection.library.entries[0]?.details).toContain("Improved the service handover");
    expect(Object.values(projection.sourceMap).find(ref => ref.assertionId === factId)?.publicText).toBe(true);
    expect(await getCareerRecommendationProfile(db, owner)).toBeNull();
  });

  it("ranks role-relevant facts before the CV input cap and leaves all facts in Experience", async () => {
    const id = randomUUID(), relevant = randomUUID();
    await save([record(id, "Programme delivery")]);
    await save(Array.from({ length: 20 }, (_, index) => assertion(randomUUID(), id, `Routine operational duty ${index}`)));
    const added = await save([assertion(relevant, id, "Designed cybersecurity incident response")]);
    const projection = await careerCvEvidence(db, owner, added.revision, { roleText: "Cybersecurity lead", priorityTerms: ["incident response"] });
    expect(projection.library.entries[0]?.details).toContain("Designed cybersecurity incident response");
    expect(Object.values(projection.sourceMap).some(ref => ref.assertionId === relevant)).toBe(true);
    expect(projection.excluded.some(row => row.reason === "capacity")).toBe(true);
    expect((await db.select().from(careerAssertions)).length).toBe(21);
  });
});
