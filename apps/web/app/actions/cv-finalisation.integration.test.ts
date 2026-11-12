import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createDb, saveCareerChange, schema, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { createTestDb } from "@/test/db";
import { signInTestUser } from "@/test/auth";
import { cvDraftEditBaseHash } from "@/lib/cv-edit-base";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let userId: string;
const rendering = vi.hoisted(() => ({ invalid: false, display: undefined as unknown }));
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => session ? { value: session } : undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/cv-pdf", async original => {
  const real = await original<typeof import("@/lib/cv-pdf")>();
  return { ...real, renderCvPdfWithReport: async (...args: Parameters<typeof real.renderCvPdfWithReport>) => {
    rendering.display = args[1];
    const report = await real.renderCvPdfWithReport(...args);
    return rendering.invalid ? { ...report, pdf: Buffer.alloc(0) } : report;
  } };
});
import { prepareCvFinalisation, approveCvFinalisation } from "./cv-finalisation";

const library = { name: "Alex", contact: "London", profile: "Analyst",
  entries: [{ id: "role", kind: "experience" as const, heading: "Analyst", details: "Analysed reports", confirmedResponsibilities: ["Analysed reports"] }] };
const content = { name: "Alex", contact: "London", summary: "Analyst with reporting experience.",
  sections: [{ entryId: "role", kind: "experience" as const, heading: "My manually edited heading", bullets: ["Analysed reports"] }], gaps: [] };

beforeAll(async () => {
  const client = createTestDb(); database = client.db; pool = client.pool;
  await runMigrations(database); process.env.SESSION_SECRET = "finalisation-test-secret";
});
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  rendering.invalid = false; rendering.display = undefined;
  await database.execute(sql`truncate ai_calls, ai_reservations, applications, cv_versions, cv_drafts, cv_libraries, companies, tasks, settings, user_settings, users restart identity cascade`);
  const signed = await signInTestUser(database, process.env.SESSION_SECRET!);
  session = signed.cookie; userId = signed.user.id;
});

async function draft(extra: Partial<typeof schema.cvDrafts.$inferInsert> = {}) {
  const [row] = await database.insert(schema.cvDrafts).values({ userId, jobTitle: "Analyst", companyName: "Example",
    jobDescription: "Analyse reports", libraryVersion: 1, librarySnapshot: library, model: "claude-haiku-4-5",
    status: "ready", revision: 1, content, ...extra }).returning();
  return row!;
}

it("finalises unchecked Manual wording with exact PDF and approval provenance, without a task or credit", async () => {
  const row = await draft({ editingMode: "manual" });
  const prepared = await prepareCvFinalisation(row.id, row.revision, cvDraftEditBaseHash(row.content, row.targetingBrief));
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return;
  expect(prepared.assessmentState).toBe("unchecked");
  expect(prepared.warnings.map(warning => warning.id)).toContain("assessment");
  expect(prepared.warnings.some(warning => /heading/i.test(warning.text))).toBe(true);
  expect(rendering.display).toBeUndefined();
  expect(await approveCvFinalisation(row.id, prepared.token, true)).toEqual({ ok: true });
  const [pdf] = await database.select().from(schema.cvPdfs).where(eq(schema.cvPdfs.draftId, row.id));
  expect(pdf?.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pdf?.approvalMode).toBe("unchecked");
  expect(pdf?.measuredPages).toBe(prepared.measuredPages);
  expect(pdf?.acknowledgedWarnings).toContain("assessment");
  expect((await database.select().from(schema.tasks)).length).toBe(0);
  expect((await database.select().from(schema.cvPdfs).where(eq(schema.cvPdfs.draftId, row.id))).length).toBe(1);
  expect((await approveCvFinalisation(row.id, prepared.token, true)).ok).toBe(false);
});

it("refuses foreign, paused, stale, active and unrenderable revisions", async () => {
  const owned = await draft();
  const paused = await draft({ status: "awaiting_evidence", revision: 2 });
  const hash = cvDraftEditBaseHash(owned.content, owned.targetingBrief);
  expect((await prepareCvFinalisation(paused.id, paused.revision, cvDraftEditBaseHash(paused.content, paused.targetingBrief))).ok).toBe(false);
  expect((await prepareCvFinalisation(owned.id, 99, hash)).ok).toBe(false);
  const prepared = await prepareCvFinalisation(owned.id, owned.revision, hash);
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return;
  expect((await approveCvFinalisation(owned.id, prepared.token, "true" as unknown as boolean)).ok).toBe(false);
  await database.update(schema.cvDrafts).set({ content: { ...content, summary: "Changed after review" } })
    .where(eq(schema.cvDrafts.id, owned.id));
  expect((await approveCvFinalisation(owned.id, prepared.token, true)).ok).toBe(false);
  expect(await database.select().from(schema.cvPdfs).where(eq(schema.cvPdfs.draftId, owned.id))).toHaveLength(0);
  const other = await signInTestUser(database, process.env.SESSION_SECRET!);
  session = other.cookie;
  expect((await prepareCvFinalisation(owned.id, 1, hash)).ok).toBe(false);
  expect((await approveCvFinalisation(owned.id, prepared.token, true)).ok).toBe(false);
  session = undefined;
  const own = await signInTestUser(database, process.env.SESSION_SECRET!);
  session = own.cookie; userId = own.user.id;
  const active = await draft();
  await database.insert(schema.tasks).values({ type: "generate_cv", dedupeKey: `generate_cv:${active.id}`,
    payload: { draftId: active.id }, status: "queued" });
  expect((await prepareCvFinalisation(active.id, 1, cvDraftEditBaseHash(active.content, active.targetingBrief))).ok).toBe(false);
  await database.delete(schema.tasks).where(eq(schema.tasks.dedupeKey, `generate_cv:${active.id}`));
  rendering.invalid = true;
  expect((await prepareCvFinalisation(active.id, 1, cvDraftEditBaseHash(active.content, active.targetingBrief))).ok).toBe(false);
});

it("does not approve across renderer releases or turn whitespace into a final CV", async () => {
  const previousCommit = process.env.RENDER_GIT_COMMIT;
  try {
    process.env.RENDER_GIT_COMMIT = "renderer-before";
    const row = await draft({ editingMode: "manual" });
    const prepared = await prepareCvFinalisation(row.id, row.revision, cvDraftEditBaseHash(row.content, row.targetingBrief));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    process.env.RENDER_GIT_COMMIT = "renderer-after";
    expect((await approveCvFinalisation(row.id, prepared.token, true)).ok).toBe(false);
    expect(await database.select().from(schema.cvPdfs).where(eq(schema.cvPdfs.draftId, row.id))).toHaveLength(0);
    const blank = await draft({ revision: 2, content: { ...content, summary: "   ",
      sections: [{ ...content.sections[0]!, heading: "  ", bullets: ["   "] }] } });
    expect((await prepareCvFinalisation(blank.id, blank.revision,
      cvDraftEditBaseHash(blank.content, blank.targetingBrief))).ok).toBe(false);
  } finally { if (previousCommit === undefined) delete process.env.RENDER_GIT_COMMIT;
    else process.env.RENDER_GIT_COMMIT = previousCommit; }
});

it.each(["auto", "refine", "manual"] as const)("finalises saved %s wording while Experience conflicts remain open and change", async editingMode => {
  const row = await draft({ editingMode });
  const recordId = crypto.randomUUID();
  const firstId = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  const context = { attribute: "revenue", scope: "project", period: "2025", value: "£1m" };
  const saved = await saveCareerChange(database, userId, { expectedRevision: 0, requestKey: crypto.randomUUID(), operations: [
    { type: "create_record", id: recordId, kind: "project", fields: {
      title: "A separate project", originalNarrative: "", dates: { start: null, end: null, current: false },
      arrangement: "contract", publicLabel: null, confidential: false, industries: [] } },
    { type: "add_assertion", id: firstId, subjectId: recordId, text: "Delivered £1m revenue", publicText: null, facets: [], context },
    { type: "add_assertion", id: secondId, subjectId: recordId, text: "Delivered £2m revenue", publicText: null, facets: [], context: { ...context, value: "£2m" } },
  ] });
  expect(saved.ok, JSON.stringify(saved)).toBe(true);
  if (!saved.ok) return;
  expect(saved.conflicts).toHaveLength(1);
  const prepared = await prepareCvFinalisation(row.id, row.revision, cvDraftEditBaseHash(row.content, row.targetingBrief));
  expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
  if (!prepared.ok) return;
  // An account-level conflict changes while the user reviews the pinned PDF. It is not a CV edit.
  const changed = await saveCareerChange(database, userId, { expectedRevision: saved.revision, requestKey: crypto.randomUUID(), operations: [
    { type: "edit_assertion", id: secondId, expectedRevision: 1, text: "Delivered £3m revenue", publicText: null,
      facets: [], context: { ...context, value: "£3m" } },
  ] });
  expect(changed.ok, JSON.stringify(changed)).toBe(true);
  expect(await approveCvFinalisation(row.id, prepared.token, true)).toEqual({ ok: true });
  const [final] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, row.id));
  const [pdf] = await database.select().from(schema.cvPdfs).where(eq(schema.cvPdfs.draftId, row.id));
  expect(final?.content).toEqual(row.content);
  expect(final?.librarySnapshot).toEqual(row.librarySnapshot);
  expect(final?.finalisedAt).not.toBeNull();
  expect(pdf?.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(await database.select().from(schema.tasks)).toHaveLength(0);
  expect(await database.select().from(schema.creditReservations)).toHaveLength(0);
});
