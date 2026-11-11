import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { CareerOperation, CareerRecordFields } from "@col/core/career-record";
import { createDb } from "./client";
import { runMigrations } from "./migrate";
import { saveCareerChange } from "./career-record";
import { careerCvEvidence } from "./career-cv";
import { decideCareerConflict, getCareerConflictDetail, getCareerReviewSummary,
  listCareerReviewIssues } from "./career-review";
import { careerReviewEvents, users } from "./schema";

const connection = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/col_test", { max: 3 });
const db = connection.db;
let owner: string;
const fields = (title: string): CareerRecordFields => ({ title, originalNarrative: "", dates: { start: null, end: null, current: false },
  arrangement: null, publicLabel: null, confidential: false, industries: [] });
const fact = (id: string, subjectId: string, text: string, value: string): CareerOperation => ({ type: "add_assertion", id,
  subjectId, text, publicText: null, facets: ["metric"],
  context: { attribute: "team size", scope: "delivery", period: "2024", value } });
async function save(operations: CareerOperation[], expectedRevision: number) {
  const result = await saveCareerChange(db, owner, { requestKey: randomUUID(), expectedRevision, operations });
  if (!result.ok) throw new Error(result.error);
  return result.revision;
}
async function seeded() {
  const recordId = randomUUID(), first = randomUUID(), second = randomUUID();
  let revision = await save([{ type: "create_record", id: recordId, kind: "project", fields: fields("Delivery") }], 0);
  revision = await save([fact(first, recordId, "Led five colleagues", "5"),
    fact(second, recordId, "Led six colleagues", "6")], revision);
  const issue = (await listCareerReviewIssues(db, owner)).items[0]!;
  return { recordId, first, second, revision, issue };
}

beforeAll(async () => { await runMigrations(db); });
beforeEach(async () => {
  await db.execute(sql`truncate users restart identity cascade`);
  const [account] = await db.insert(users).values({ name: "Career owner", email: "review@example.test" }).returning({ id: users.id });
  owner = account!.id;
});
afterAll(async () => { await connection.pool.end(); });

describe("durable account-owned Experience review", () => {
  it("persists a chosen version, retains historical omission and refuses stale or reused intent", async () => {
    const { recordId, second, revision, issue } = await seeded();
    expect(await getCareerReviewSummary(db, owner)).toEqual({ needsReview: true, activeCount: 1, deferredCount: 0 });
    const before = await careerCvEvidence(db, owner, revision);
    expect(before.library.entries).toHaveLength(0);
    const input = { conflictId: issue.id, expectedFingerprint: issue.fingerprint, expectedDecisionRevision: 0,
      requestKey: randomUUID(), choice: "choose" as const, selectedAssertionId: second };
    const chosen = await decideCareerConflict(db, owner, input);
    expect(chosen).toMatchObject({ ok: true, decisionRevision: 1, summary: { activeCount: 0 } });
    if (!chosen.ok) throw new Error(chosen.error);
    expect((await careerCvEvidence(db, owner, chosen.careerVersion!)).sourceMap[`entry:${recordId}:row:0`]?.assertionId).toBe(second);
    expect((await careerCvEvidence(db, owner, revision)).library.entries).toHaveLength(0);
    expect(await decideCareerConflict(db, owner, input)).toEqual(chosen);
    await expect(decideCareerConflict(db, owner, { ...input, selectedAssertionId: randomUUID() })).rejects.toThrow("different decision");
    await expect(decideCareerConflict(db, owner, { ...input, requestKey: randomUUID() })).rejects.toThrow("reviewed in another tab");
    expect(await db.select().from(careerReviewEvents)).toHaveLength(1);
  });

  it("defers unresolved attention without changing source eligibility, then restores it", async () => {
    const { revision, issue } = await seeded();
    const deferred = await decideCareerConflict(db, owner, { conflictId: issue.id,
      expectedFingerprint: issue.fingerprint, expectedDecisionRevision: 0,
      requestKey: randomUUID(), choice: "later" });
    expect(deferred).toMatchObject({ ok: true, careerVersion: null,
      summary: { needsReview: false, activeCount: 0, deferredCount: 1 } });
    expect((await careerCvEvidence(db, owner, revision)).library.entries).toHaveLength(0);
    const restored = await decideCareerConflict(db, owner, { conflictId: issue.id,
      expectedFingerprint: issue.fingerprint, expectedDecisionRevision: 1,
      requestKey: randomUUID(), choice: "reopen" });
    expect(restored).toMatchObject({ ok: true, careerVersion: null,
      summary: { needsReview: true, activeCount: 1, deferredCount: 0 } });
  });

  it("does not report an older replay as the current decision", async () => {
    const { first, second, issue } = await seeded();
    const base = { conflictId: issue.id, expectedFingerprint: issue.fingerprint };
    const firstInput = { ...base, expectedDecisionRevision: 0, requestKey: randomUUID(),
      choice: "choose" as const, selectedAssertionId: first };
    await decideCareerConflict(db, owner, firstInput);
    await decideCareerConflict(db, owner, { ...base, expectedDecisionRevision: 1,
      requestKey: randomUUID(), choice: "choose", selectedAssertionId: second });
    await expect(decideCareerConflict(db, owner, firstInput)).rejects.toThrow("newer review decision");
    expect((await getCareerConflictDetail(db, owner, issue.id))?.decision?.selectedAssertionId).toBe(second);
  });

  it("refuses keep-both edits that move statements into another shared conflicting scope", async () => {
    const { first, second, issue } = await seeded();
    const detail = (await getCareerConflictDetail(db, owner, issue.id))!;
    const originals = [first, second].map(id => detail.statements.find(row => row.id === id)!);
    const edits = originals.map(row => ({ id: row.id, expectedRevision: row.revision, text: row.text,
      publicText: row.publicText, facets: row.facets, context: {
        attribute: "team size", scope: "another shared team", period: "2024", value: row.context!.value } }));
    await expect(decideCareerConflict(db, owner, { conflictId: issue.id,
      expectedFingerprint: issue.fingerprint, expectedDecisionRevision: 0, requestKey: randomUUID(),
      choice: "keep_both_context", edits })).rejects.toThrow("still describe the same scope");
    expect(await db.select().from(careerReviewEvents)).toHaveLength(0);
  });

  it("corrects a fact atomically and preserves its earlier statement in history", async () => {
    const { first, revision, issue } = await seeded();
    const detail = await getCareerConflictDetail(db, owner, issue.id);
    expect(detail?.statements).toHaveLength(2);
    const original = detail!.statements.find(row => row.id === first)!;
    const corrected = await decideCareerConflict(db, owner, { conflictId: issue.id,
      expectedFingerprint: issue.fingerprint, expectedDecisionRevision: 0, requestKey: randomUUID(),
      choice: "correct", edits: [{ id: first, expectedRevision: original.revision,
        text: "Led five colleagues in a different unit", publicText: null, facets: ["metric"],
        context: { attribute: "team size", scope: "different unit", period: "2024", value: "5" } }] });
    expect(corrected).toMatchObject({ ok: true, summary: { activeCount: 0 } });
    expect((await careerCvEvidence(db, owner, revision)).library.entries).toHaveLength(0);
    expect((await getCareerConflictDetail(db, owner, issue.id))?.history[0]?.choice).toBe("correct");
  });

  it("pins two CV-only conflict choices independently of form order", async () => {
    const firstGroup = await seeded();
    const otherRecord = randomUUID(), third = randomUUID(), fourth = randomUUID();
    let revision = await save([{ type: "create_record", id: otherRecord, kind: "project", fields: fields("Second delivery") }], firstGroup.revision);
    revision = await save([fact(third, otherRecord, "Led three colleagues", "3"),
      fact(fourth, otherRecord, "Led four colleagues", "4")], revision);
    const issues = (await listCareerReviewIssues(db, owner)).items;
    expect(issues).toHaveLength(2);
    const choices = await Promise.all(issues.map(async issue => {
      const detail = (await getCareerConflictDetail(db, owner, issue.id))!;
      return { groupKey: detail.groupKey, fingerprint: detail.fingerprint,
        chosenAssertionId: detail.statements[0]!.id };
    }));
    const forward = await careerCvEvidence(db, owner, revision, { conflictChoices: choices });
    const reversed = await careerCvEvidence(db, owner, revision, { conflictChoices: [...choices].reverse() });
    expect(forward.library).toEqual(reversed.library);
    expect(forward.library.careerProjection?.conflictChoices?.map(row => row.groupKey))
      .toEqual([...choices.map(row => row.groupKey)].sort());
  });
});
