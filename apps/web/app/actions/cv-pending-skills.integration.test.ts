import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { CvContentSchema, CvLibrarySchema } from "@col/core/cv";
import { cvUserSkillProposals } from "@col/core/cv-pending-skills";
import { eq, sql } from "drizzle-orm";
import { signInTestUser } from "@/test/auth";
import { createTestDb } from "@/test/db";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let userId: string;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (session ? { value: session } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { decideCvPendingSkill } from "./cv-pending-skills";

const library = CvLibrarySchema.parse({ name: "Candidate", contact: "London", profile: "Operations",
  structuredExperience: true, employment: [{ id: "job", company: "Acme", jobTitle: "Manager", current: false,
    startDate: "2020-01", endDate: "2022-01" }], entries: [
  { id: "role", kind: "experience", employmentId: "job", heading: "Manager", details: "Led a team", confirmedResponsibilities: ["Led a team"] },
] });
const content = CvContentSchema.parse({ name: "Candidate", contact: "London", summary: "Operations manager", gaps: [], sections: [
  { entryId: "role", kind: "experience", heading: "Manager", bullets: ["Led a team"] },
  { entryId: "manual-skills", kind: "skill", heading: "Leadership", bullets: ["Team leadership"], skillItems: ["Team leadership"] },
] });

beforeAll(async () => {
  const client = createTestDb(); database = client.db; pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "pending-skill-test-secret";
});
afterAll(async () => { await pool.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate cv_drafts, cv_libraries, tasks, users restart identity cascade`);
  const signed = await signInTestUser(database, process.env.SESSION_SECRET!);
  userId = signed.user.id; session = signed.cookie;
  await database.insert(schema.cvLibraries).values({ userId, version: 1, content: library });
});

async function draft(snapshot = library, body = content, pendingSkillProposals?: typeof schema.cvDrafts.$inferInsert.pendingSkillProposals) {
  const [saved] = await database.insert(schema.cvDrafts).values({ userId, jobTitle: "Manager", companyName: "Acme",
    jobDescription: "Lead a team", libraryVersion: 1, librarySnapshot: snapshot, model: "claude-sonnet-5",
    status: "ready", revision: 1, content: body, pendingSkillProposals }).returning();
  return saved!;
}

it("accepts a member-confirmed linked skill once, writes Experience and a free CV revision", async () => {
  const source = await draft();
  const proposal = cvUserSkillProposals(library, content)[0]!;
  const requestKey = crypto.randomUUID();
  const input = { decision: "accept" as const, evidence: { kind: "link_existing" as const,
    evidenceEntryId: "entry:role:row:0" }, confirmFactual: true as const, expectedRevision: 1, requestKey };
  const first = await decideCvPendingSkill(source.id, proposal.id, input);
  expect(first.ok).toBe(true);
  expect(await decideCvPendingSkill(source.id, proposal.id, input)).toEqual(first);
  expect(await decideCvPendingSkill(source.id, proposal.id,
    { ...input, evidence: { kind: "link_existing", evidenceEntryId: "entry:role:row:1" } })).toMatchObject({ ok: false });
  const versions = await database.select().from(schema.cvLibraries).where(eq(schema.cvLibraries.userId, userId));
  expect(versions).toHaveLength(2);
  expect(versions[1]?.content.entries.find(entry => entry.kind === "skill")?.skillItems).toEqual(["Team leadership"]);
  const revisions = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.userId, userId));
  expect(revisions).toHaveLength(2);
  expect(revisions.find(row => row.parentId === source.id)).toMatchObject({ status: "ready", revision: 2,
    libraryVersion: 2, assessment: null });
  expect(revisions.find(row => row.id === source.id)?.pendingSkillProposals?.[0]).toMatchObject({ status: "accepted", decisionRequestKey: requestKey });
});

it("adds a short, explicitly confirmed Experience example with the skill", async () => {
  const source = await draft();
  const proposal = cvUserSkillProposals(library, content)[0]!;
  const result = await decideCvPendingSkill(source.id, proposal.id, { decision: "accept",
    evidence: { kind: "new_confirmed_row", destinationEntryId: "role", factualExample: "Coached six analysts through weekly delivery reviews." },
    confirmFactual: true, expectedRevision: 1, requestKey: crypto.randomUUID() });
  expect(result.ok).toBe(true);
  const versions = await database.select().from(schema.cvLibraries).where(eq(schema.cvLibraries.userId, userId));
  expect(versions[1]?.content.entries[0]?.confirmedResponsibilities).toContain("Coached six analysts through weekly delivery reviews.");
});

it("accepts a confirmed imported Experience row whose stable entry ID contains colons", async () => {
  const importedId = "import-example:p1:evidence";
  const snapshot = CvLibrarySchema.parse({ ...library,
    entries: library.entries.map(entry => ({ ...entry, id: importedId })) });
  const body = CvContentSchema.parse({ ...content,
    sections: content.sections.map(section => section.kind === "experience" ? { ...section, entryId: importedId } : section) });
  await database.update(schema.cvLibraries).set({ content: snapshot }).where(eq(schema.cvLibraries.userId, userId));
  const source = await draft(snapshot, body);
  const proposal = cvUserSkillProposals(snapshot, body)[0]!;
  const result = await decideCvPendingSkill(source.id, proposal.id, { decision: "accept",
    evidence: { kind: "link_existing", evidenceEntryId: `entry:${importedId}:row:0` },
    confirmFactual: true, expectedRevision: 1, requestKey: crypto.randomUUID() });
  expect(result.ok).toBe(true);
  expect(await database.select().from(schema.cvLibraries).where(eq(schema.cvLibraries.userId, userId))).toHaveLength(2);
});

it("does not add a sixth CV skill category, while leaving the Library and source untouched", async () => {
  const body = CvContentSchema.parse({ ...content, sections: [content.sections[0]!,
    ...Array.from({ length: 5 }, (_, index) => ({ entryId: `known-${index}`, kind: "skill" as const,
      heading: `Category ${index}`, bullets: [`Skill ${index}`], skillItems: [`Skill ${index}`] }))] });
  const proposal = { id: crypto.randomUUID(), label: "New skill", category: "Sixth category",
    origin: "model" as const, status: "pending" as const };
  const source = await draft(library, body, [proposal]);
  const result = await decideCvPendingSkill(source.id, proposal.id, { decision: "accept",
    evidence: { kind: "link_existing", evidenceEntryId: "entry:role:row:0" },
    confirmFactual: true, expectedRevision: 1, requestKey: crypto.randomUUID() });
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining("up to 5 skill sections") });
  expect(await database.select().from(schema.cvLibraries).where(eq(schema.cvLibraries.userId, userId))).toHaveLength(1);
  expect(await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.userId, userId))).toHaveLength(1);
});

it("keeps another account's CV and Experience untouched", async () => {
  const source = await draft();
  const proposal = cvUserSkillProposals(library, content)[0]!;
  const stranger = await signInTestUser(database, process.env.SESSION_SECRET!, "other@example.com");
  session = stranger.cookie;
  const result = await decideCvPendingSkill(source.id, proposal.id, { decision: "accept",
    evidence: { kind: "link_existing", evidenceEntryId: "entry:role:row:0" }, confirmFactual: true,
    expectedRevision: 1, requestKey: crypto.randomUUID() });
  expect(result.ok).toBe(false);
  expect(await database.select().from(schema.cvLibraries).where(eq(schema.cvLibraries.userId, userId))).toHaveLength(1);
  expect(await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.userId, userId))).toHaveLength(1);
});
