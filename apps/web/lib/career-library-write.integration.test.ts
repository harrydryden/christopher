import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { CvLibrarySchema, type CvLibrary } from "@col/core/cv";
import { createTestDb } from "@/test/db";
import { writeCvLibraryVersion } from "./cv-library-write";

vi.mock("@/lib/enqueue", () => ({ enqueue: vi.fn() }));
let connection: ReturnType<typeof createTestDb>;
let database: Db;
let userId: string;
const library = CvLibrarySchema.parse({ name: "Career owner", contact: "London", profile: "Delivery experience", entries: [
  { id: "job", kind: "experience", heading: "Manager · Example · 2021–2024", details: "Led service delivery" },
] });

beforeAll(async () => { connection = createTestDb(); database = connection.db; await runMigrations(database); });
beforeEach(async () => {
  await database.execute(sql`truncate users, tasks restart identity cascade`);
  const [user] = await database.insert(schema.users).values({ email: "career-writer@example.test", name: "Career owner" }).returning();
  userId = user!.id;
  await database.insert(schema.cvLibraries).values({ userId, version: 1, content: library });
});
afterAll(async () => { await connection?.pool.end(); });
const write = (version: number, build: (current: CvLibrary | null) => CvLibrary,
  options: Parameters<typeof writeCvLibraryVersion>[4] = { review: false }) =>
  database.transaction(tx => writeCvLibraryVersion(tx, userId, version, build, options));

it("lands accepted document facts and their provenance atomically while preserving the old Library", async () => {
  await write(1, current => ({ ...current!, entries: [...current!.entries,
    { id: "imported", kind: "skill", heading: "Planning", details: "Programme planning" }] }),
  { review: false, careerOrigin: "document", careerSourceId: "import:test-document" });
  const facts = await database.select().from(schema.careerAssertions).where(eq(schema.careerAssertions.userId, userId));
  expect(facts.find(row => row.text === "Led service delivery")?.provenance.kind).toBe("legacy_saved");
  expect(facts.find(row => row.text === "Programme planning")).toMatchObject({ status: "usable",
    provenance: { kind: "document", sourceId: "import:test-document" } });
  const [old] = await database.select().from(schema.cvLibraries).where(eq(schema.cvLibraries.version, 1));
  expect(old?.content).toEqual(library);
  expect(await database.select().from(schema.tasks)).toHaveLength(0);
});

it("does not duplicate or relabel existing facts on a profile-only save and rejects stale retries", async () => {
  await write(1, current => ({ ...current!, entries: [...current!.entries,
    { id: "imported", kind: "skill", heading: "Planning", details: "Programme planning" }] }),
  { review: false, careerOrigin: "document", careerSourceId: "import:test-document" });
  const before = await database.select().from(schema.careerAssertions).where(eq(schema.careerAssertions.userId, userId));
  await write(2, current => ({ ...current!, contact: "Manchester" }));
  const after = await database.select().from(schema.careerAssertions).where(eq(schema.careerAssertions.userId, userId));
  expect(after).toEqual(before);
  await expect(write(2, current => ({ ...current!, contact: "Stale address" }))).rejects.toThrow("changed");
  expect(await database.select().from(schema.cvLibraries)).toHaveLength(3);
  expect(await database.select().from(schema.careerAssertions)).toHaveLength(before.length);
});

it("rolls back the compatibility version and career facts together when the outer transaction fails", async () => {
  await expect(database.transaction(async tx => {
    await writeCvLibraryVersion(tx, userId, 1, current => ({ ...current!, entries: [...current!.entries,
      { id: "new", kind: "skill", heading: "Delivery", details: "Stakeholder management" }] }), { review: false });
    throw new Error("Simulated outer failure");
  })).rejects.toThrow("Simulated outer failure");
  expect(await database.select().from(schema.cvLibraries)).toHaveLength(1);
  expect(await database.select().from(schema.careerAssertions)).toHaveLength(0);
  expect(await database.select().from(schema.careerChanges)).toHaveLength(0);
});

it("retains a long accepted source paragraph without exceeding the provenance quote bound", async () => {
  const text = `Delivered a detailed programme. ${"Recorded supporting context. ".repeat(180)}`.trim();
  await write(1, current => ({ ...current!, entries: [...current!.entries,
    { id: "long-import", kind: "education", heading: "Professional programme", details: text }] }),
  { review: false, careerOrigin: "document", careerSourceId: "import:long-document" });
  const facts = await database.select().from(schema.careerAssertions).where(eq(schema.careerAssertions.userId, userId));
  const imported = facts.find(row => row.text === text);
  expect(imported?.provenance.originalText).toBe(text);
  expect(imported?.provenance.sourceId).toBe("import:long-document");
  expect(imported?.provenance.quote?.length ?? 0).toBeLessThanOrEqual(4000);
});

it("does not let an identical model proposal swallow a newly accepted documentary fact", async () => {
  await write(1, current => ({ ...current!, entries: [...current!.entries,
    { id: "skills", kind: "skill", heading: "Planning", details: "Programme planning" }] }),
  { review: false, careerOrigin: "document", careerSourceId: "import:first" });
  const [fact] = (await database.select().from(schema.careerAssertions)).filter(row => row.text === "Programme planning");
  await database.insert(schema.careerAssertions).values({ id: crypto.randomUUID(), userId, subjectId: fact!.subjectId,
    revision: 1, text: "Demand forecasting", publicText: null, facets: ["skill"], status: "proposed",
    provenance: { kind: "model", sourceId: null, quote: null, originalText: "Demand forecasting", captureContext: "suggestion" } });
  await write(2, current => ({ ...current!, entries: current!.entries.map(entry => entry.kind === "skill"
    ? { ...entry, details: `${entry.details}\nDemand forecasting` } : entry) }),
  { review: false, careerOrigin: "document", careerSourceId: "import:second" });
  const rows = (await database.select().from(schema.careerAssertions)).filter(row => row.text === "Demand forecasting");
  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.provenance.kind === "model")?.status).toBe("proposed");
  expect(rows.find(row => row.provenance.kind === "document")).toMatchObject({ status: "usable", provenance: { sourceId: "import:second" } });
});
