import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { CareerChangeResult, CareerOperation, CareerRecordFields } from "@col/core/career-record";
import { createDb } from "./client";
import { runMigrations } from "./migrate";
import { saveCareerChange } from "./career-record";
import { careerCvEvidence } from "./career-cv";
import { careerAssertions, users } from "./schema";

const connection = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/col_test", { max: 3 });
const db = connection.db;
let userId: string;
const fields = (title: string): CareerRecordFields => ({ title, originalNarrative: "", dates: { start: null, end: null, current: false },
  arrangement: null, publicLabel: null, confidential: false, industries: [] });
const saved = (result: CareerChangeResult) => { if (!result.ok) throw new Error(result.error); return result; };
async function save(operations: CareerOperation[], expectedRevision: number) {
  return saved(await saveCareerChange(db, userId, { requestKey: randomUUID(), expectedRevision, operations }));
}
const fact = (id: string, subjectId: string, text: string, value: string | null): Extract<CareerOperation, { type: "add_assertion" }> => ({
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
    expect(chosen.library.entries[0]?.details).toContain("Led six colleagues [team size: 6; delivery; 2024]");
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

  it("keeps explicit public contexts distinct and never appends private context to CV wording", async () => {
    const publicId = randomUUID(), privateId = randomUUID();
    let revision = (await save([{ type: "create_record", id: publicId, kind: "project", fields: fields("Public delivery") },
      { type: "create_record", id: privateId, kind: "project", fields: { ...fields("SecretCo delivery"),
        confidential: true, publicLabel: "Confidential client" } }], 0)).revision;
    revision = (await save([
      { ...fact(randomUUID(), publicId, "Led five colleagues", "5"), context: {
        attribute: "team size", scope: "North unit", period: "2024", value: "5" } },
      { ...fact(randomUUID(), publicId, "Led five colleagues", "5"), context: {
        attribute: "team size", scope: "South unit", period: "2024", value: "5" } },
      { ...fact(randomUUID(), privateId, "SecretCo delivery", "8"), publicText: "Delivered client work",
        context: { attribute: "team size", scope: "SecretCo private unit", period: "2024", value: "8" } },
    ], revision)).revision;
    const projection = await careerCvEvidence(db, userId, revision);
    const publicEntry = projection.library.entries.find(row => row.id === publicId)!;
    expect(publicEntry.details).toContain("North unit");
    expect(publicEntry.details).toContain("South unit");
    const privateEntry = projection.library.entries.find(row => row.id === privateId)!;
    expect(privateEntry.details).toBe("Delivered client work");
    expect(JSON.stringify(projection.library)).not.toContain("SecretCo");
  });

  it("keeps a long accepted fact durable while excluding its whole over-cap contextual row", async () => {
    const recordId = randomUUID(), longId = randomUUID(), shortId = randomUUID();
    let revision = (await save([{ type: "create_record", id: recordId, kind: "project", fields: fields("Delivery") }], 0)).revision;
    const longText = "A".repeat(39_990);
    revision = (await save([fact(longId, recordId, longText, "12"),
      { ...fact(shortId, recordId, "Delivered the smaller project", null), context: null }], revision)).revision;
    expect((await db.select().from(careerAssertions)).find(row => row.id === longId)?.text).toBe(longText);
    const projected = await careerCvEvidence(db, userId, revision);
    expect(projected.library.entries[0]?.details).toBe("Delivered the smaller project");
    expect(projected.excluded).toContainEqual({ recordId, assertionId: longId, reason: "capacity" });
  });

  it("keeps a saved skill label atomic despite its structured context", async () => {
    const recordId = randomUUID(), labelId = randomUUID();
    let revision = (await save([{ type: "create_record", id: recordId, kind: "skill", fields: fields("Skills") }], 0)).revision;
    const label = "Programme planning";
    revision = (await save([{ ...fact(labelId, recordId, label, "1"), facets: ["skill"] }], revision)).revision;
    const projected = await careerCvEvidence(db, userId, revision);
    expect(projected.library.entries[0]?.skillItems).toEqual([label]);
    expect(projected.library.entries[0]?.details).toBe(label);
  });
});
