import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { eq, sql } from "drizzle-orm";
import { createSessionCookieValue } from "@/lib/session";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => session ? { value: session } : undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
import { savePreferenceProfile, savePinnedStatements, acceptReasonTag } from "./learning";
import { decide, saveDecisionTags, archiveRoles, decideRoles } from "./decisions";
import { recordApplication, updateApplication } from "./applications";
import { GET as downloadApplication } from "@/app/api/applications/[id]/pdf/route";
import { saveCvLibrary, requestCv, saveCvDraft, saveCvModel } from "./cv";
import { fetchTableJobs } from "@/lib/queries/jobs";
import { saveKeywords } from "./settings";
import { useDiscoveryCandidate, deleteCompany } from "./companies";

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "integration-test-secret";
});
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate cv_libraries, cv_drafts, companies, decisions, tasks, settings, preference_profiles, tag_vocabulary restart identity cascade`);
  session = await createSessionCookieValue(process.env.SESSION_SECRET!);
});
async function fixture() {
  const [company] = await database.insert(schema.companies).values({ name: "Acme", domain: "acme.example", homepageUrl: "https://acme.example" }).returning();
  const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://acme.example/jobs" }).returning();
  const [job] = await database.insert(schema.jobs).values({ companyId: company!.id, sourceId: source!.id, title: "Operations Manager", normalizedTitle: "operations manager", externalKey: "one", url: "https://acme.example/jobs/one", inTable: true, keywordMatched: true, keywordTerms: ["operations"] }).returning();
  return { company: company!, job: job!, source: source! };
}

describe("authenticated mutations", () => {
  it("rejects unauthenticated action calls before writing", async () => {
    const { job } = await fixture();
    session = undefined;
    await expect(decide(job.id, "apply", "Good fit")).rejects.toThrow("Unauthorised");
    expect(await database.select().from(schema.decisions)).toHaveLength(0);
  });
  it("serialises competing decisions and retains history on undo", async () => {
    const { job } = await fixture();
    const results = await Promise.all([decide(job.id, "apply", "Good fit"), decide(job.id, "skip", "Too junior")]);
    expect(results.every(r => r.ok)).toBe(true);
    let rows = await database.select().from(schema.decisions).where(eq(schema.decisions.jobId, job.id));
    expect(rows).toHaveLength(2);
    expect(rows.filter(r => !r.superseded)).toHaveLength(1);
    await decide(job.id, null, "");
    rows = await database.select().from(schema.decisions).where(eq(schema.decisions.jobId, job.id));
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.superseded)).toBe(true);
  });
  it("updates gate membership before a keyword save returns", async () => {
    const { job } = await fixture();
    const form = new FormData();
    form.set("includeKeywords", "engineering");
    await saveKeywords({ ok: true }, form);
    const [updated] = await database.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(updated).toBeUndefined();
  });
  it("makes concurrent repeated source confirmation idempotent", async () => {
    const { company } = await fixture();
    const [run] = await database.insert(schema.discoveryRuns).values({ companyId: company.id, status: "needs_confirmation", candidates: [{ spec: { type: "greenhouse", url: "https://job-boards.greenhouse.io/acme", atsSlug: "acme" } }] }).returning();
    await Promise.all([useDiscoveryCandidate(run!.id, 0), useDiscoveryCandidate(run!.id, 0)]);
    const sources = await database.select().from(schema.careerSources).where(eq(schema.careerSources.type, "greenhouse"));
    expect(sources).toHaveLength(1);
  });
  it("retains decision snapshots when a company is deleted", async () => {
    const { company, job } = await fixture();
    await decide(job.id, "apply", "Good fit");
    await expect(deleteCompany(company.id)).rejects.toThrow("redirect:/companies");
    expect(await database.select().from(schema.jobs)).toHaveLength(0);
    const decisions = await database.select().from(schema.decisions).where(eq(schema.decisions.companyName, "Acme"));
    expect(decisions.some(d => d.jobId === null && d.jobTitle === "Operations Manager")).toBe(true);
  });
});


describe("learning controls", () => {
  it("creates immutable profile versions and rejects an obsolete edit", async () => {
    const first = new FormData(); first.set("markdown", "Operations leadership in London"); first.set("profileVersion", "0");
    await savePreferenceProfile(first);
    const second = new FormData(); second.set("markdown", "Operations leadership, UK remote"); second.set("profileVersion", "1");
    await savePreferenceProfile(second);
    await expect(savePreferenceProfile(second)).rejects.toThrow("changed");
    const profiles = await database.select().from(schema.preferenceProfiles).orderBy(schema.preferenceProfiles.version);
    expect(profiles.map(p => p.markdown)).toEqual(["Operations leadership in London", "Operations leadership, UK remote"]);
  });
  it("can pin preferences before any model profile exists", async () => {
    const form = new FormData(); form.set("pinnedStatements", "No relocation."); form.set("profileVersion", "0");
    await savePinnedStatements(form);
    const [profile] = await database.select().from(schema.preferenceProfiles);
    expect(profile!.pinnedStatements).toEqual(["No relocation."]);
    expect(profile!.version).toBe(1);
  });
  it("requires vocabulary approval and preserves manual tag edits", async () => {
    const { job } = await fixture();
    await decide(job.id, "skip", "Too junior");
    const [decision] = await database.select().from(schema.decisions).where(eq(schema.decisions.jobId, job.id));
    await database.insert(schema.tagVocabulary).values({ tag: "seniority:too_junior", accepted: false });
    const form = new FormData(); form.append("tags", "seniority:too_junior");
    await expect(saveDecisionTags(decision!.id, form)).rejects.toThrow("accepted");
    await acceptReasonTag("seniority:too_junior");
    await saveDecisionTags(decision!.id, form);
    const [updated] = await database.select().from(schema.decisions).where(eq(schema.decisions.id, decision!.id));
    expect(updated!.tags).toEqual(["seniority:too_junior"]);
    expect(updated!.tagsEdited).toBe(true);
  });
});


describe("priority workflows", () => {
  it("archives without deleting evidence, restores and synchronously applies seniority", async () => {
    const { job } = await fixture();
    expect((await fetchTableJobs()).length).toBe(1);
    expect((await archiveRoles([job.id], true)).ok).toBe(true);
    expect(await fetchTableJobs()).toHaveLength(0);
    expect(await fetchTableJobs(true)).toHaveLength(1);
    const form = new FormData(); form.set("includeKeywords", "operations"); form.set("seniorityKeywords", "director");
    await saveKeywords({ ok: true }, form);
    expect(await fetchTableJobs(true)).toHaveLength(1);
    await archiveRoles([job.id], false);
    expect(await fetchTableJobs()).toHaveLength(0);
    const [stored] = await database.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(stored!.archivedAt).toBeNull(); expect(stored!.inTable).toBe(false);
  });
  it("records bulk decisions with required reasons and retained snapshots", async () => {
    const { job, company, source } = await fixture();
    const [second] = await database.insert(schema.jobs).values({ companyId: company.id, sourceId: source.id, externalKey: "two", title: "Finance Director", normalizedTitle: "finance director", url: "https://acme.example/two" }).returning();
    const ids = [job.id, second!.id];
    expect((await decideRoles(ids, "skip", "")).ok).toBe(false);
    expect(await database.select().from(schema.decisions)).toHaveLength(0);
    expect((await decideRoles(ids, "skip", "Too junior")).ok).toBe(true);
    const decisions = await database.select().from(schema.decisions);
    expect(decisions).toHaveLength(2);
    expect(decisions.every(d => d.reason === "Too junior")).toBe(true);
    expect((await database.select().from(schema.tasks)).some(t => t.type === "suggest_filters")).toBe(true);
  });
  it("versions libraries and snapshots generation inputs atomically with its task", async () => {
    const { job } = await fixture();
    const content = { name: "Test Candidate", contact: "London", profile: "Operations leader", entries: [{ id: "one", kind: "experience", heading: "Director · Acme", details: "Led an operations team" }] };
    const form = new FormData(); form.set("library", JSON.stringify(content)); form.set("version", "0");
    expect((await saveCvLibrary({ ok: true }, form)).ok).toBe(true);
    expect((await saveCvLibrary({ ok: true }, form)).ok).toBe(false);
    const generate = new FormData(); generate.set("jobId", job.id);
    expect((await requestCv({ ok: true }, generate)).ok).toBe(false);
    generate.set("description", "Lead a business operations team, develop the annual operating plan and work with finance and commercial leaders.");
    await expect(requestCv({ ok: true }, generate)).rejects.toThrow("redirect:/cv/");
    const [draft] = await database.select().from(schema.cvDrafts);
    expect(draft!.librarySnapshot).toEqual(content); expect(draft!.model).toBe("claude-sonnet-5");
    expect(await database.select().from(schema.tasks).where(eq(schema.tasks.type, "generate_cv"))).toHaveLength(1);
    await database.update(schema.cvDrafts).set({ status: "ready", revision: 1, content: { name: content.name, contact: content.contact, summary: "Original", sections: [{ entryId: "one", kind: "experience", heading: "Director · Acme", bullets: ["Led a team"] }], gaps: [] } }).where(eq(schema.cvDrafts.id, draft!.id));
    const edit = new FormData(); edit.set("summary", "Edited summary"); edit.set("section-0", "Led the operations team"); edit.set("rememberWording", "on");
    await expect(saveCvDraft(draft!.id, { ok: true }, edit)).rejects.toThrow("redirect:/cv/");
    const versions = await database.select().from(schema.cvDrafts).orderBy(schema.cvDrafts.revision);
    expect(versions.map(v => v.content?.summary)).toEqual(["Original", "Edited summary"]);
    expect(versions[1]!.parentId).toBe(draft!.id);
    const libraries = await database.select().from(schema.cvLibraries).orderBy(schema.cvLibraries.version);
    expect(libraries).toHaveLength(2);
    expect(libraries[0]!.content.preferredWording).toBeUndefined();
    expect(libraries[1]!.content.preferredWording).toContain("Led the operations team");
    const application = new FormData(); application.set("appliedOn", "2026-02-30");
    expect((await recordApplication(versions[1]!.id, { ok: true }, application)).ok).toBe(false);
    application.set("appliedOn", "2026-09-06");
    expect((await recordApplication(versions[1]!.id, { ok: true }, application)).ok).toBe(true);
    expect((await recordApplication(versions[1]!.id, { ok: true }, application)).ok).toBe(false);
    const [savedApplication] = await database.select().from(schema.applications);
    const frozen = savedApplication!.pdfBase64;
    expect(Buffer.from(frozen, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    const update = new FormData(); update.set("status", "interview"); update.set("notes", "First interview arranged");
    expect((await updateApplication(savedApplication!.id, { ok: true }, update)).ok).toBe(true);
    const [after] = await database.select().from(schema.applications);
    expect(after!.history.map(h => h.status)).toEqual(["applied", "interview"]);
    expect(after!.pdfBase64).toBe(frozen);
    expect(after!.cvId).toBe(versions[1]!.id);
    const response = await downloadApplication(new Request("https://example.test"), { params: Promise.resolve({ id: after!.id }) });
    expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(frozen);

  });
  it("does not allow the CV and scraping model to be the same", async () => {
    const form = new FormData(); form.set("cvModel", "claude-opus-5");
    expect((await saveCvModel({ ok: true }, form)).ok).toBe(false);
  });
});

it("queues an explicit board URL even while homepage discovery is pending", async () => {
  const { company } = await fixture();
  await database.insert(schema.tasks).values({ type: "discover", payload: { companyId: company.id }, dedupeKey: `discover:${company.id}` });
  const { pasteDiscoveryUrl } = await import("./companies");
  const form = new FormData(); form.set("url", "https://job-boards.greenhouse.io/acme");
  await pasteDiscoveryUrl(company.id, form);
  const tasks = await database.select().from(schema.tasks).where(eq(schema.tasks.type, "discover"));
  expect(tasks).toHaveLength(2);
  expect(tasks.some(t => (t.payload as { url?: string }).url?.includes("greenhouse"))).toBe(true);
});
