import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { createTestDb } from "@/test/db";
import { signInTestUser } from "@/test/auth";
import { and, eq, sql } from "drizzle-orm";
import type { User } from "@col/db/schema";
import { cvSkillDraftContext } from "@col/core/cv-skill-draft-context";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let user: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => session ? { value: session } : undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

import { readCvSkillSuggestions, requestCvSkillSuggestions, saveCvDraft } from "./cv";

const library = { name: "Ada", contact: "London", profile: "Analyst",
  employment: [{ id: "job-1", company: "Example", jobTitle: "Analyst", startDate: "", endDate: "", current: true }],
  entries: [
  { id: "role", kind: "experience" as const, heading: "Analyst", employmentId: "job-1", details: "Used Excel to report results", confirmedResponsibilities: ["Used Excel to report results"] },
] };
const content = { name: "Ada", contact: "London", summary: "Analyst", gaps: [], sections: [
  { entryId: "role", kind: "experience" as const, heading: "Analyst", bullets: ["Used Excel to report results"] },
] };

beforeAll(async () => {
  const client = createTestDb(); database = client.db; pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "cv-skill-suggestion-test-secret";
});
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate cv_skill_suggestion_runs, cv_drafts, cv_libraries, tasks, user_settings, users restart identity cascade`);
  ({ user, cookie: session } = await signInTestUser(database, process.env.SESSION_SECRET!));
});

async function fixture() {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
  const [draft] = await database.insert(schema.cvDrafts).values({ userId: user.id, jobTitle: "Analyst", companyName: "Example",
    jobDescription: "Use spreadsheets to manage reports", libraryVersion: 1, librarySnapshot: library,
    model: "claude-haiku-4-5", status: "ready", revision: 1, content }).returning();
  return draft!;
}

const form = (runId: string, selected: string[], summary = "Analyst", intent?: string) => {
  const data = new FormData();
  data.set("summary", summary); data.set("skillSuggestionRunId", runId); data.set("selectedSuggestionIds", JSON.stringify(selected));
  if (intent) data.set("intent", intent);
  return data;
};
const request = (draft: Awaited<ReturnType<typeof fixture>>, edited = content, refresh = false, pageLibraryVersion = 1) =>
  requestCvSkillSuggestions(draft.id, refresh, pageLibraryVersion, edited, draft.revision);

it("queues one owned proposal and refuses another account's read", async () => {
  const draft = await fixture();
  expect(await request(draft, content, false, 0)).toMatchObject({ ok: false });
  const first = await request(draft);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.run.status).toBe("queued");
  const again = await request(draft);
  expect(again.ok && again.run.id).toBe(first.run.id);
  const queued = await database.select().from(schema.tasks).where(eq(schema.tasks.type, "suggest_cv_skills"));
  expect(queued).toHaveLength(1);
  expect(queued[0]!.payload).toMatchObject({ baseRevision: draft.revision,
    draftContext: cvSkillDraftContext(content) });
  const ownerRead = await readCvSkillSuggestions(draft.id, first.run.id);
  expect(ownerRead.ok).toBe(true);
  const other = await signInTestUser(database, process.env.SESSION_SECRET!, "other-skill@example.com");
  session = other.cookie;
  expect((await readCvSkillSuggestions(draft.id, first.run.id)).ok).toBe(false);
  expect((await requestCvSkillSuggestions(draft.id)).ok).toBe(false);
});

it("binds unsaved Write wording to the run and accepts selected skills only with that same wording", async () => {
  const draft = await fixture();
  const edited = { ...content, summary: "Analyst using Excel", sections: [{ ...content.sections[0]!,
    bullets: ["Used Excel to report monthly results"] }] };
  const requested = await request(draft, edited);
  if (!requested.ok) throw new Error(requested.error);
  const [queued] = await database.select().from(schema.tasks).where(eq(schema.tasks.type, "suggest_cv_skills"));
  expect(queued!.payload).toMatchObject({ baseRevision: 1, draftContext: cvSkillDraftContext(edited) });
  const chosen = crypto.randomUUID();
  await database.update(schema.cvSkillSuggestionRuns).set({ status: "ready", suggestions: [{ id: chosen,
    category: "Data tools", label: "Excel", sourceId: "entry:role:row:0", evidenceQuote: "Used Excel", roleQuote: "spreadsheets" }] })
    .where(eq(schema.cvSkillSuggestionRuns.id, requested.run.id));
  const save = form(requested.run.id, [chosen], "Analyst using Excel ");
  save.set("section-0", "Used Excel to report monthly results");
  await expect(saveCvDraft(draft.id, { ok: true }, save)).rejects.toThrow(/^redirect:\/cv\//);
  const [accepted] = await database.select().from(schema.cvSkillSuggestionRuns).where(eq(schema.cvSkillSuggestionRuns.id, requested.run.id));
  const [saved] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, accepted!.acceptedDraftId!));
  expect(saved!.content?.summary).toBe("Analyst using Excel");
  expect(saved!.content?.sections[0]?.bullets).toEqual(["Used Excel to report monthly results"]);
  expect(saved!.content?.sections.flatMap(section => section.skillItems ?? [])).toEqual(["Excel"]);
});

it("rejects an underlying Write edit after generation before any Library skill write", async () => {
  const draft = await fixture();
  const requested = await request(draft);
  if (!requested.ok) throw new Error(requested.error);
  const chosen = crypto.randomUUID();
  await database.update(schema.cvSkillSuggestionRuns).set({ status: "ready", suggestions: [{ id: chosen,
    category: "Data tools", label: "Excel", sourceId: "entry:role:row:0", evidenceQuote: "Used Excel", roleQuote: "spreadsheets" }] })
    .where(eq(schema.cvSkillSuggestionRuns.id, requested.run.id));
  expect(await saveCvDraft(draft.id, { ok: true }, form(requested.run.id, [chosen], "Changed summary")))
    .toMatchObject({ ok: false, error: expect.stringContaining("Write section changed") });
  expect((await database.select().from(schema.cvLibraries))).toHaveLength(1);
  expect((await database.select().from(schema.cvDrafts))).toHaveLength(1);
});

it("saves selected labels only, replays exactly once and rejects changed wording or intent", async () => {
  const draft = await fixture();
  const requested = await request(draft);
  if (!requested.ok) throw new Error(requested.error);
  const chosen = crypto.randomUUID(), unchosen = crypto.randomUUID();
  const proposals = [chosen, unchosen].map((id, index) => ({ id, category: "Data tools", label: index ? "Python" : "Excel",
    sourceId: "entry:role:row:0", evidenceQuote: "Used Excel", roleQuote: "spreadsheets" }));
  await database.update(schema.cvSkillSuggestionRuns).set({ status: "ready", suggestions: proposals })
    .where(eq(schema.cvSkillSuggestionRuns.id, requested.run.id));
  await expect(saveCvDraft(draft.id, { ok: true }, form(requested.run.id, [chosen]))).rejects.toThrow(/^redirect:\/cv\//);
  const [accepted] = await database.select().from(schema.cvSkillSuggestionRuns).where(eq(schema.cvSkillSuggestionRuns.id, requested.run.id));
  expect(accepted?.acceptedDraftId).toBeTruthy();
  const [latest] = await database.select().from(schema.cvLibraries).where(and(eq(schema.cvLibraries.userId, user.id), eq(schema.cvLibraries.version, 2)));
  expect(latest?.content.entries.flatMap(entry => entry.skillItems ?? [])).toEqual(["Excel"]);
  const [saved] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, accepted!.acceptedDraftId!));
  expect(saved?.content?.sections.flatMap(section => section.skillItems ?? [])).toEqual(["Excel"]);
  expect(saved?.libraryVersion).toBe(2);
  await expect(saveCvDraft(draft.id, { ok: true }, form(requested.run.id, [chosen]))).rejects.toThrow(`redirect:/cv/${saved!.id}`);
  expect((await database.select().from(schema.cvLibraries))).toHaveLength(2);
  expect((await database.select().from(schema.cvDrafts))).toHaveLength(2);
  expect(await saveCvDraft(draft.id, { ok: true }, form(requested.run.id, [chosen], "Changed"))).toMatchObject({ ok: false });
  expect(await saveCvDraft(draft.id, { ok: true }, form(requested.run.id, [chosen], "Analyst", "improve"))).toMatchObject({ ok: false });
  expect((await database.select().from(schema.cvLibraries))).toHaveLength(2);
});

it("rejects stale, forged and foreign selections without writing skills", async () => {
  const draft = await fixture();
  const requested = await request(draft);
  if (!requested.ok) throw new Error(requested.error);
  const chosen = crypto.randomUUID();
  await database.update(schema.cvSkillSuggestionRuns).set({ status: "ready", suggestions: [{ id: chosen, category: "Data tools",
    label: "Excel", sourceId: "entry:role:row:0", evidenceQuote: "Used Excel", roleQuote: "spreadsheets" }] })
    .where(eq(schema.cvSkillSuggestionRuns.id, requested.run.id));
  expect(await saveCvDraft(draft.id, { ok: true }, form(requested.run.id, [crypto.randomUUID()]))).toMatchObject({ ok: false });
  const ownerCookie = session;
  const other = await signInTestUser(database, process.env.SESSION_SECRET!, "foreign-skill@example.com");
  session = other.cookie;
  expect(await saveCvDraft(draft.id, { ok: true }, form(requested.run.id, [chosen]))).toMatchObject({ ok: false });
  session = ownerCookie;
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 2, content: { ...library,
    entries: [{ ...library.entries[0]!, details: "Used different tools", confirmedResponsibilities: ["Used different tools"] }] } });
  expect(await saveCvDraft(draft.id, { ok: true }, form(requested.run.id, [chosen]))).toMatchObject({ ok: false });
  expect((await database.select().from(schema.cvLibraries))).toHaveLength(2);
  expect((await database.select().from(schema.cvDrafts))).toHaveLength(1);
});

it("a save with no selected proposal creates no skills Library version", async () => {
  const draft = await fixture();
  await expect(saveCvDraft(draft.id, { ok: true }, form("", []))).rejects.toThrow(/^redirect:\/cv\//);
  expect((await database.select().from(schema.cvLibraries))).toHaveLength(1);
  expect((await database.select().from(schema.cvSkillSuggestionRuns))).toHaveLength(0);
});

it("saves a renamed CV skill section without renaming its Experience entry", async () => {
  const draft = await fixture();
  const skillLibrary = { ...library, entries: [...library.entries,
    { id: "skill-1", kind: "skill" as const, heading: "Technical skills", details: "Python", skillItems: ["Python"] }] };
  const skillContent = { ...content, sections: [...content.sections,
    { entryId: "skill-1", kind: "skill" as const, heading: "Technical skills", bullets: ["Python"], skillItems: ["Python"] }] };
  await database.update(schema.cvLibraries).set({ content: skillLibrary }).where(eq(schema.cvLibraries.userId, user.id));
  await database.update(schema.cvDrafts).set({ content: skillContent, librarySnapshot: skillLibrary }).where(eq(schema.cvDrafts.id, draft.id));
  const invalid = form("", []);
  invalid.set("skill-heading-1", "   ");
  expect(await saveCvDraft(draft.id, { ok: true }, invalid)).toMatchObject({ ok: false,
    error: expect.stringContaining("heading of 1 to 250 characters") });
  expect((await database.select().from(schema.cvDrafts))).toHaveLength(1);
  const edit = form("", []);
  edit.set("skill-heading-1", "  Data tools  ");
  edit.set("skills-1", "Python\nSQL");
  await expect(saveCvDraft(draft.id, { ok: true }, edit)).rejects.toThrow(/^redirect:\/cv\//);
  const [revision] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, draft.id));
  expect(revision?.content?.sections[1]).toMatchObject({ entryId: "skill-1", heading: "Data tools", skillItems: ["Python", "SQL"] });
  const [latestLibrary] = await database.select().from(schema.cvLibraries).where(eq(schema.cvLibraries.userId, user.id));
  expect(latestLibrary?.version).toBe(1);
  expect(latestLibrary?.content.entries.find(entry => entry.id === "skill-1")?.heading).toBe("Technical skills");
});

it("rejects a supporting Training choice from a stale page after another-tab Library change", async () => {
  const draft = await fixture();
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 2, content: { ...library,
    entries: [...library.entries, { id: "training-new", kind: "training", heading: "PRINCE2", details: "PRINCE2 Practitioner" }] } });
  const stale = form("", []);
  stale.set("addedSupportIds", JSON.stringify(["training-new"]));
  stale.set("pageLibraryVersion", "1");
  expect(await saveCvDraft(draft.id, { ok: true }, stale)).toMatchObject({ ok: false,
    error: expect.stringContaining("changed in another tab") });
  expect((await database.select().from(schema.cvDrafts))).toHaveLength(1);
});
