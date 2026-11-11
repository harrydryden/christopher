import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { CareerChangeResult, CareerOperation, CareerRecordFields } from "@col/core/career-record";
import { createDb } from "./client";
import { runMigrations } from "./migrate";
import { saveCareerChange } from "./career-record";
import { careerCvEvidence } from "./career-cv";
import { users } from "./schema";

const connection = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/col_test", { max: 3 });
const db = connection.db;
let userId: string;
const fields = (title: string): CareerRecordFields => ({ title, originalNarrative: "", dates: { start: null, end: null, current: false },
  arrangement: null, publicLabel: null, confidential: false, industries: [] });
const saved = (result: CareerChangeResult) => { if (!result.ok) throw new Error(result.error); return result; };
async function save(operations: CareerOperation[], expectedRevision: number) {
  return saved(await saveCareerChange(db, userId, { requestKey: randomUUID(), expectedRevision, operations }));
}
const fact = (id: string, subjectId: string, text: string, value: string | null): CareerOperation => ({
  type: "add_assertion", id, subjectId, text, publicText: null, facets: ["metric"],
  context: value ? { attribute: "team size", scope: "delivery", period: "2024", value } : null,
});

beforeAll(async () => { await runMigrations(db); });
beforeEach(async () => {
  await db.execute(sql`truncate users restart identity cascade`);
  const [account] = await db.insert(users).values({ name: "Career owner", email: "career-conflict@example.test" }).returning({ id: users.id });
  userId = account!.id;
});
afterAll(async () => { await connection.pool.end(); });

describe("historical career CV selection", () => {
  it("omits both unresolved conflicting values, then honours exactly one explicit chosen fact", async () => {
    const recordId = randomUUID(), first = randomUUID(), second = randomUUID();
    let revision = (await save([{ type: "create_record", id: recordId, kind: "project", fields: fields("Delivery") }], 0)).revision;
    revision = (await save([fact(first, recordId, "Led five colleagues", "5"),
      fact(second, recordId, "Led six colleagues", "6")], revision)).revision;
    const unresolved = await careerCvEvidence(db, userId, revision);
    expect(unresolved.library.entries).toHaveLength(0);
    expect(unresolved.excluded.filter(row => row.reason === "conflict").map(row => row.assertionId).sort())
      .toEqual([first, second].sort());
    const chosen = await careerCvEvidence(db, userId, revision, { assertionIds: [second] });
    expect(chosen.library.entries[0]?.details).toBe("Led six colleagues");
    expect(chosen.sourceMap[`entry:${recordId}:row:0`]?.assertionId).toBe(second);
    const both = await careerCvEvidence(db, userId, revision, { assertionIds: [first, second] });
    expect(both.library.entries).toHaveLength(0);
  });

  it("does not republish a disputed sentence from the original story when the opposite fact is chosen", async () => {
    const recordId = randomUUID(), first = randomUUID(), second = randomUUID();
    let revision = (await save([{ type: "create_record", id: recordId, kind: "project",
      fields: { ...fields("Delivery"), originalNarrative: "Led five colleagues\nOther safe work" } }], 0)).revision;
    revision = (await save([fact(first, recordId, "Led five colleagues", "5"),
      fact(second, recordId, "Led six colleagues", "6")], revision)).revision;
    const implicit = await careerCvEvidence(db, userId, revision);
    expect(implicit.library.entries[0]?.details).toBe("Other safe work");
    expect(implicit.library.entries[0]?.details).not.toContain("Led five colleagues");
    const opposite = await careerCvEvidence(db, userId, revision, { assertionIds: [second] });
    expect(opposite.library.entries[0]?.details).toContain("Led six colleagues");
    expect(opposite.library.entries[0]?.details).not.toContain("Led five colleagues");
  });

  it("uses a matching saved perspective only to rank linked eligible facts", async () => {
    const recordId = randomUUID(), unrelatedId = randomUUID(), linkedId = randomUUID(), perspectiveId = randomUUID();
    let revision = (await save([{ type: "create_record", id: recordId, kind: "project", fields: fields("Delivery") }], 0)).revision;
    revision = (await save([fact(unrelatedId, recordId, "Built an operational checklist", null),
      fact(linkedId, recordId, "Coordinated colleagues", null)], revision)).revision;
    revision = (await save([{ type: "save_perspective", id: perspectiveId, expectedRevision: 0,
      label: "Leadership operational checklist", note: "Private framing, not an evidence claim", assertionIds: [linkedId] }], revision)).revision;
    const before = await careerCvEvidence(db, userId, revision - 1, { roleText: "Leadership operational checklist" });
    const after = await careerCvEvidence(db, userId, revision, { roleText: "Leadership operational checklist" });
    expect(before.sourceMap[`entry:${recordId}:row:0`]?.assertionId).toBe(unrelatedId);
    expect(after.sourceMap[`entry:${recordId}:row:0`]?.assertionId).toBe(linkedId);
    expect(after.library.entries[0]?.details).not.toContain("Private framing");
    expect(after.library.entries[0]?.details).not.toContain("Leadership");
    expect(after.sourceMap[`entry:${recordId}:row:0`]?.assertionId).toBe(linkedId);
  });
});
