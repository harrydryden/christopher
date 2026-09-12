import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@christopher/db";
import { DEFAULT_CV_THEME } from "@christopher/core/cv";
import { DEFAULT_SETTINGS, modelForCallSite } from "@christopher/core";
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
import { GET as workStatus } from "@/app/api/work-status/route";
import { GET as downloadApplication } from "@/app/api/applications/[id]/pdf/route";
import { saveCvLibrary, requestCv, saveCvDraft, saveCvModel, setCvArchived } from "./cv";
import { fetchRolePage, fetchRoleDetails, parseRolesFilters, fetchTableJobs, fetchRecentEventsFor } from "@/lib/queries/jobs";
import { saveKeywords } from "./settings";
import { addCompanies, useDiscoveryCandidate, deleteCompany, updateCompanyDetails, refreshCompany } from "./companies";

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
  it("refreshes known sources once and brings scheduled scans forward", async () => {
    const { company } = await fixture();
    await Promise.all([refreshCompany(company.id), refreshCompany(company.id)]);
    const [task] = await database.select().from(schema.tasks);
    expect(task!.type).toBe("scan_company");
    expect(await database.select().from(schema.tasks)).toHaveLength(1);
    await database.update(schema.tasks).set({ dedupeKey: `scan_company:${company.id}:preserved-run`, runAfter: new Date(Date.now() + 3600000), payload: { companyId: company.id, trigger: "schedule", scanRunId: "preserved-run" } }).where(eq(schema.tasks.id, task!.id));
    await refreshCompany(company.id);
    const [updated] = await database.select().from(schema.tasks);
    expect(updated!.runAfter.getTime()).toBeLessThanOrEqual(Date.now());
    expect(updated!.payload).toMatchObject({ trigger: "manual", scanRunId: "preserved-run" });
    expect(await database.select().from(schema.tasks)).toHaveLength(1);
  });
  it("discovers missing sources but preserves source confirmation and company pauses", async () => {
    const { company, source } = await fixture();
    await database.update(schema.careerSources).set({ status: "needs_confirmation" }).where(eq(schema.careerSources.id, source.id));
    await expect(refreshCompany(company.id)).rejects.toThrow(`redirect:/companies/${company.id}`);
    expect(await database.select().from(schema.tasks)).toHaveLength(0);
    await database.update(schema.careerSources).set({ status: "disabled" }).where(eq(schema.careerSources.id, source.id));
    await refreshCompany(company.id);
    expect((await database.select().from(schema.tasks))[0]!.type).toBe("discover");
    await database.delete(schema.tasks);
    await database.update(schema.companies).set({ status: "paused" }).where(eq(schema.companies.id, company.id));
    await refreshCompany(company.id);
    expect(await database.select().from(schema.tasks)).toHaveLength(0);
    session = undefined;
    await expect(refreshCompany(company.id)).rejects.toThrow("Unauthorised");
  });

  it("corrects the homepage and domain without changing sources or roles", async () => {
    const { company, source, job } = await fixture();
    const form = new FormData(); form.set("homepageUrl", "www.corrected.example"); form.set("name", "Acme");
    expect(await updateCompanyDetails(company.id, { ok: true }, form)).toEqual({ ok: true });
    const [updated] = await database.select().from(schema.companies).where(eq(schema.companies.id, company.id));
    expect(updated!.homepageUrl).toBe("https://www.corrected.example/");
    expect(updated!.domain).toBe("corrected.example");
    const logoTasks = await database.select().from(schema.tasks);
    expect(logoTasks).toHaveLength(1);
    expect(logoTasks[0]!.payload).toMatchObject({ companyId: company.id, logoOnly: true, homepageUrl: "https://www.corrected.example/" });
    await updateCompanyDetails(company.id, { ok: true }, form);
    expect(await database.select().from(schema.tasks)).toHaveLength(1);
    expect((await database.select().from(schema.careerSources))[0]!.url).toBe(source.url);
    expect((await database.select().from(schema.jobs))[0]!.id).toBe(job.id);
    form.set("homepageUrl", "javascript:alert(1)");
    expect((await updateCompanyDetails(company.id, { ok: true }, form)).ok).toBe(false);
    await database.insert(schema.companies).values({ name: "Other", domain: "other.example", homepageUrl: "https://other.example/" });
    form.set("homepageUrl", "other.example");
    expect((await updateCompanyDetails(company.id, { ok: true }, form)).ok).toBe(false);
    session = undefined;
    await expect(updateCompanyDetails(company.id, { ok: true }, form)).rejects.toThrow("Unauthorised");
  });
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
    expect(updated!.inTable).toBe(false);
    expect(updated!.archivedAt).not.toBeNull();
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
    expect(stored!.archivedAt).not.toBeNull(); expect(stored!.inTable).toBe(false);
  });
  it("reports completion without returning full company or CV records", async () => {
    const [task] = await database.insert(schema.tasks).values({ type: 'scan_company', payload: {}, priority: 3 }).returning();
    const pending = await workStatus(new Request('http://localhost/api/work-status'));
    expect((await pending.json()).active).toBe(true);
    await database.update(schema.tasks).set({ status: 'done' }).where(eq(schema.tasks.id, task!.id));
    expect((await (await workStatus(new Request('http://localhost/api/work-status'))).json()).active).toBe(false);
  });
  it("filters and pages roles in SQL before loading descriptions", async () => {
    const { job, company, source } = await fixture();
    await database.insert(schema.jobs).values(Array.from({ length: 55 }, (_, i) => ({ companyId: company.id, sourceId: source.id, externalKey: `page-${i}`, title: `Role ${String(i).padStart(2, '0')}`, normalizedTitle: `role ${i}`, url: `https://acme.example/${i}`, inTable: true, location: 'London' })));
    const filters = parseRolesFilters({ q: 'Role', location: 'London', sort: 'title' });
    const first = await fetchRolePage(filters, false, null, 1);
    const second = await fetchRolePage(filters, false, null, 2);
    expect(first.total).toBe(55);
    expect(first.visible).toHaveLength(50);
    expect(second.visible).toHaveLength(5);
    expect(first.visible[0]!.job.title).toBe('Role 00');
    await decide(second.visible[0]!.job.id, 'skip', 'Not relevant');
    expect((await fetchRolePage(filters, false, null, 2)).total).toBe(54);
    expect((await fetchRolePage({ ...filters, decision: 'skip' }, false, null, 1)).visible).toHaveLength(1);
  });
  it("loads descriptions only for requested role detail IDs", async () => {
    const { job } = await fixture();
    await database.update(schema.jobs).set({ descriptionText: "Stored role description" }).where(eq(schema.jobs.id, job.id));
    const summaries = await fetchTableJobs(false, true);
    expect(summaries.find(row => row.job.id === job.id)!.job.descriptionText).toBeNull();
    const details = await fetchRoleDetails([job.id]);
    expect(details).toHaveLength(1);
    expect(details[0]!.job.descriptionText).toBe("Stored role description");
    expect(await fetchRoleDetails([])).toEqual([]);
  });
  it("records bulk decisions with optional reasons and retained snapshots", async () => {
    const { job, company, source } = await fixture();
    const [second] = await database.insert(schema.jobs).values({ companyId: company.id, sourceId: source.id, externalKey: "two", title: "Finance Director", normalizedTitle: "finance director", url: "https://acme.example/two" }).returning();
    const ids = [job.id, second!.id];
    expect((await decideRoles(ids, "skip", "")).ok).toBe(true);
    expect(await database.select().from(schema.decisions)).toHaveLength(2);
    expect((await decideRoles(ids, "skip", "Too junior")).ok).toBe(true);
    const decisions = await database.select().from(schema.decisions).where(eq(schema.decisions.superseded, false));
    expect(decisions).toHaveLength(2);
    expect(decisions.every(d => d.reason === "Too junior")).toBe(true);
    expect((await database.select().from(schema.tasks)).some(t => t.type === "suggest_filters")).toBe(true);
  });
  it("rolls back a decision when its learning task cannot be persisted", async () => {
    const { job } = await fixture();
    await database.execute(sql`alter table tasks add constraint audit_reject_tag_task check (type <> 'tag_reason') not valid`);
    try {
      expect((await decide(job.id, "skip", "Too junior")).ok).toBe(false);
      expect(await database.select().from(schema.decisions)).toHaveLength(0);
      expect(await database.select().from(schema.tasks)).toHaveLength(0);
    } finally {
      await database.execute(sql`alter table tasks drop constraint audit_reject_tag_task`);
    }
  });
  it("saves legacy employment as a new library version and rejects dangling job links", async () => {
    const oldContent = { name: "Test Candidate", contact: "London", profile: "Leader", entries: [{ id: "one", kind: "experience" as const, heading: "Director · Acme", details: "Led a team" }] };
    await database.insert(schema.cvLibraries).values({ version: 1, content: oldContent });
    const form = new FormData(); form.set("version", "1"); form.set("library", JSON.stringify(oldContent));
    expect((await saveCvLibrary({ ok: true }, form)).ok).toBe(true);
    const versions = await database.select().from(schema.cvLibraries).orderBy(schema.cvLibraries.version);
    expect(versions[0]!.content).toEqual(oldContent);
    expect(versions[1]!.content.employment).toEqual([{ id: "one", company: "Acme", jobTitle: "Director", startDate: "", endDate: "", current: false }]);
    expect(versions[1]!.content.entries[0]!.employmentId).toBe("one");
    expect(versions[1]!.content.entries[0]!.confirmedResponsibilities).toEqual([]);
    form.set("version", "2"); form.set("library", JSON.stringify({ ...versions[1]!.content, employment: [] }));
    expect((await saveCvLibrary({ ok: true }, form)).ok).toBe(false);
    expect(await database.select().from(schema.cvLibraries)).toHaveLength(2);
  });
  it("does not queue a CV from unconfirmed experience", async () => {
    const { job } = await fixture();
    await database.insert(schema.cvLibraries).values({ version: 1, content: { name: "Test Candidate", contact: "London", profile: "", entries: [{ id: "one", kind: "experience", status: "active", heading: "Director · Acme", details: "An unconfirmed proposal" }] } });
    const generate = new FormData(); generate.set("jobId", job.id);
    const result = await requestCv({ ok: true }, generate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("confirm the responsibilities");
    expect(await database.select().from(schema.cvDrafts)).toHaveLength(0);
    expect(await database.select().from(schema.tasks).where(eq(schema.tasks.type, "generate_cv"))).toHaveLength(0);
  });
  it("saves skill items and palettes without rewriting the original CV or application", async () => {
    const library: import("@christopher/core/cv").CvLibrary = { name: "Example", contact: "London", profile: "Analyst", theme: DEFAULT_CV_THEME, entries: [{ id: "skills", kind: "skill", heading: "Tools", details: "Reporting", skillItems: ["SQL", "Python"] }] };
    const form = new FormData(); form.set("library", JSON.stringify(library)); form.set("version", "0");
    expect(await saveCvLibrary({ ok: true }, form)).toEqual({ ok: true });
    expect((await database.select().from(schema.cvLibraries))[0]!.content.entries[0]!.skillItems).toEqual(["SQL", "Python"]);
    const content = { theme: DEFAULT_CV_THEME, name: "Example", contact: "London", summary: "Analyst", sections: [{ entryId: "skills", kind: "skill" as const, heading: "Tools", bullets: ["Reporting"], skillItems: ["SQL"] }], gaps: [] };
    const [draft] = await database.insert(schema.cvDrafts).values({ jobTitle: "Analyst", companyName: "Example", jobDescription: "Analysis", libraryVersion: 1, librarySnapshot: library, model: "test", status: "ready", revision: 1, content }).returning();
    const application = new FormData(); application.set("appliedOn", "2026-09-06");
    expect(await recordApplication(draft!.id, { ok: true }, application)).toEqual({ ok: true });
    const frozen = (await database.select().from(schema.applications))[0]!.pdfBase64;
    const edit = new FormData(); edit.set("summary", "Analyst"); edit.set("skills-0", "SQL\nPython"); edit.set("theme", JSON.stringify({ ...DEFAULT_CV_THEME, primary: "#285447" }));
    await expect(saveCvDraft(draft!.id, { ok: true }, edit)).rejects.toThrow("redirect:/cv/");
    const versions = await database.select().from(schema.cvDrafts).orderBy(schema.cvDrafts.revision);
    expect(versions[0]!.content).toEqual(content);
    expect(versions[1]!.content!.sections[0]!.skillItems).toEqual(["SQL", "Python"]);
    expect(versions[1]!.content!.theme!.primary).toBe("#285447");
    expect((await database.select().from(schema.applications))[0]!.pdfBase64).toBe(frozen);
    edit.set("theme", JSON.stringify({ ...DEFAULT_CV_THEME, background: "invalid" }));
    expect((await saveCvDraft(draft!.id, { ok: true }, edit)).ok).toBe(false);
  });
  it("versions libraries and snapshots generation inputs atomically with its task", async () => {
    const { job } = await fixture();
    const content = { name: "Test Candidate", contact: "London", profile: "Operations leader", employment: [{ id: "job", company: "Acme", industryDescriptions: "Healthcare, SaaS", jobTitle: "Director", startDate: "2023-08", endDate: "", current: true }], entries: [{ id: "one", kind: "experience", employmentId: "job", heading: "Leadership", details: "Led an operations team\nAn unconfirmed proposal", confirmedResponsibilities: ["Led an operations team"] }] };
    const form = new FormData(); form.set("library", JSON.stringify(content)); form.set("version", "0");
    expect((await saveCvLibrary({ ok: true }, form)).ok).toBe(true);
    expect((await saveCvLibrary({ ok: true }, form)).ok).toBe(false);
    const generate = new FormData(); generate.set("jobId", job.id);
    expect((await requestCv({ ok: true }, generate)).ok).toBe(false);
    generate.set("description", "Lead a business operations team, develop the annual operating plan and work with finance and commercial leaders.");
    await expect(requestCv({ ok: true }, generate)).rejects.toThrow("redirect:/cv/");
    const [draft] = await database.select().from(schema.cvDrafts);
    expect(draft!.librarySnapshot).toEqual({ ...content, theme: DEFAULT_CV_THEME, structuredExperience: true, entries: [{ ...content.entries[0], heading: "Director · Acme · Aug 2023 – Present", status: "active", details: "Led an operations team" }] }); expect(draft!.model).toBe("claude-fable-5-1");
    expect(await database.select().from(schema.tasks).where(eq(schema.tasks.type, "generate_cv"))).toHaveLength(1);
    await database.update(schema.cvDrafts).set({ status: "ready", revision: 1, content: { name: content.name, contact: content.contact, summary: "Original", sections: [{ entryId: "one", kind: "experience", heading: "Director · Acme", industryDescriptions: ["SaaS"], bullets: ["Led a team"] }], gaps: [] } }).where(eq(schema.cvDrafts.id, draft!.id));
    const edit = new FormData(); edit.set("summary", "Edited summary"); edit.set("section-0", "Led the operations team"); edit.set("rememberWording", "on");
    await expect(saveCvDraft(draft!.id, { ok: true }, edit)).rejects.toThrow("redirect:/cv/");
    const versions = await database.select().from(schema.cvDrafts).orderBy(schema.cvDrafts.revision);
    expect(versions.map(v => v.content?.summary)).toEqual(["Original", "Edited summary"]);
    expect(versions[1]!.parentId).toBe(draft!.id);
    expect(versions[1]!.content?.sections[0]?.industryDescriptions).toEqual(["SaaS"]);
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
    // Derived from the defaults rather than hardcoded, so the collision stays real if the default model changes.
    const form = new FormData(); form.set("cvModel", modelForCallSite(DEFAULT_SETTINGS, "A3"));
    expect((await saveCvModel({ ok: true }, form)).ok).toBe(false);
  });
  it("archives a CV out of the list and restores it", async () => {
    const library = { name: "Test Candidate", contact: "London", profile: "Operations leader", entries: [{ id: "one", kind: "experience" as const, heading: "Director · Acme", details: "Led an operations team" }] };
    const [draft] = await database.insert(schema.cvDrafts).values({ jobTitle: "VP of AI Transformation", companyName: "Humanoid",
      jobDescription: "Lead the transformation", libraryVersion: 1, librarySnapshot: library, model: DEFAULT_SETTINGS.cvModel, status: "failed" }).returning();

    await setCvArchived(draft!.id, true);
    const [archived] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft!.id));
    expect(archived!.archivedAt).toBeInstanceOf(Date);

    await setCvArchived(draft!.id, false);
    const [restored] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft!.id));
    expect(restored!.archivedAt).toBeNull();
  });
  it("rejects a model ID outside the supported list", async () => {
    // A dotted version passed the old regex, was stored, and then failed on every call.
    const form = new FormData(); form.set("cvModel", "claude-fable-5.1");
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

it("returns only the newest requested events per role", async () => {
  const { job } = await fixture();
  await database.insert(schema.jobEvents).values(Array.from({ length: 30 }, (_, i) => ({ jobId: job.id, type: "updated" as const, payload: { i }, at: new Date(1700000000000 + i * 1000) })));
  const events = await fetchRecentEventsFor([job.id], 3);
  expect(events.get(job.id)!.map(e => e.payload.i)).toEqual([29, 28, 27]);
});

it("atomically adds 1,000 companies and queues setup, with a bounded response for duplicate imports", async () => {
  const form = new FormData();
  form.set("urls", Array.from({length:1000},(_,n)=>`https://bulk${n}.example`).join("\n"));
  await expect(addCompanies(form)).rejects.toThrow("redirect:/companies?added=1000");
  expect(await database.select({id:schema.companies.id}).from(schema.companies)).toHaveLength(1000);
  expect(await database.select({id:schema.tasks.id}).from(schema.tasks).where(eq(schema.tasks.type,"discover"))).toHaveLength(1000);
  await expect(addCompanies(form)).rejects.toThrow("added=0");
  expect(await database.select({id:schema.tasks.id}).from(schema.tasks)).toHaveLength(1000);
});

describe("four-status role workflow", () => {
  it("keeps counts, filtered pages and export selection aligned across transitions", async () => {
    const { fetchRoleCounts, applyRolesFilters, splitHidden } = await import("@/lib/queries/jobs");
    const { listCompanies } = await import("@/lib/queries/companies");
    const { job, company } = await fixture();
    const read = async (view: string) => fetchRolePage(parseRolesFilters({ view }), view === "archived", 99, 1);
    expect((await read("auto-matched")).total).toBe(1);
    expect((await decide(job.id, "apply", "")).ok).toBe(true);
    await database.update(schema.jobs).set({ inTable: false, fitScore: 1, status: "closed" }).where(eq(schema.jobs.id, job.id));
    expect((await read("auto-matched")).total).toBe(0);
    expect((await read("user-shortlisted")).total).toBe(1);
    expect((await fetchRoleCounts(company.id))["user-shortlisted"]).toBe(1);
    const [summary] = await listCompanies();
    expect(summary!.reviewRoles).toBe(0); expect(summary!.shortlistedRoles).toBe(1);
    const exported = splitHidden(applyRolesFilters(await fetchTableJobs(), parseRolesFilters({ view: "user-shortlisted" })), 99, false).visible;
    expect(exported.map(row => row.job.id)).toEqual([job.id]);
    expect((await archiveRoles([job.id], true)).ok).toBe(true);
    expect((await read("archived")).total).toBe(1);
    expect((await read("user-shortlisted")).total).toBe(0);
    expect((await archiveRoles([job.id], false)).ok).toBe(true);
    expect((await read("user-shortlisted")).total).toBe(1);
    expect((await decide(job.id, "skip", "")).ok).toBe(true);
    expect((await read("user-dismissed")).total).toBe(1);
    expect((await decide(job.id, null, "")).ok).toBe(true);
    expect((await read("archived")).total).toBe(1);
    expect((await archiveRoles([job.id], false)).ok).toBe(false);
    expect((await decide(job.id, "apply", "")).ok).toBe(true);
    expect((await read("user-shortlisted")).total).toBe(1);
  });
  it("archives a lost match once, retains history and restores after criteria match again", async () => {
    const { archiveNonMatches } = await import("@christopher/db");
    const { job } = await fixture();
    await database.update(schema.jobs).set({ inTable: false }).where(eq(schema.jobs.id, job.id));
    await archiveNonMatches(database);
    await archiveNonMatches(database);
    const events = await database.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, job.id));
    expect(events.filter(event => event.payload.action === "archived")).toHaveLength(1);
    expect(events[0]!.payload.reason).toBe("No longer matches your criteria");
    await database.update(schema.jobs).set({ inTable: true }).where(eq(schema.jobs.id, job.id));
    expect((await archiveRoles([job.id], false)).ok).toBe(true);
    expect((await fetchRolePage(parseRolesFilters({}), false, null, 1)).total).toBe(1);
  });
});

describe("scan reporting", () => {
  it("counts a company only when all latest source scans succeed and its task is done", async () => {
    const { scanRunSummary } = await import("@christopher/db");
    const { company, source } = await fixture();
    const [other] = await database.insert(schema.careerSources).values({ companyId: company.id, type: "html", url: "https://acme.example/other" }).returning();
    const [run] = await database.insert(schema.scanRuns).values({ runDate: "2026-09-11", trigger: "manual", companiesTotal: 1 }).returning();
    const [task] = await database.insert(schema.tasks).values({ type: "scan_company", status: "done", payload: { companyId: company.id, scanRunId: run!.id } }).returning();
    const at = new Date("2026-09-11T06:00:00Z");
    await database.insert(schema.scans).values([
      { sourceId: source.id, scanRunId: run!.id, status: "ok", startedAt: at, finishedAt: at, newCount: 2 },
      { sourceId: other!.id, scanRunId: run!.id, status: "partial", startedAt: at, finishedAt: at, newCount: 1 },
    ]);
    expect((await scanRunSummary(database, run!.id)).companies_ok).toBe(0);
    await database.insert(schema.scans).values({ sourceId: other!.id, scanRunId: run!.id, status: "ok", startedAt: new Date(at.getTime() + 1000), finishedAt: new Date(at.getTime() + 2000), newCount: 0 });
    expect(await scanRunSummary(database, run!.id)).toMatchObject({ companies_ok: 1, new_roles: 3, pending: 0 });
    await database.update(schema.tasks).set({ status: "running" }).where(eq(schema.tasks.id, task!.id));
    expect(await scanRunSummary(database, run!.id)).toMatchObject({ companies_ok: 0, pending: 1 });
    await database.update(schema.tasks).set({ status: "failed" }).where(eq(schema.tasks.id, task!.id));
    expect((await scanRunSummary(database, run!.id)).companies_ok).toBe(0);
  });
});

it("blocks oversized saved revisions, downloads and new application PDFs", async () => {
  const { GET: downloadCv } = await import("@/app/api/cv/[id]/pdf/route");
  const library = { name: "Example", contact: "London", profile: "Leader", entries: [{ id: "one", kind: "experience" as const, heading: "Director", details: "Led a team" }] };
  const content = { name: "Example", contact: "London", summary: "Leader", sections: Array.from({ length: 5 }, (_, i) => ({ entryId: String(i), kind: "experience" as const, heading: `Director ${i}`, bullets: Array.from({ length: 6 }, () => "Managed operational planning and reporting. ".repeat(14)) })), gaps: [] };
  const [draft] = await database.insert(schema.cvDrafts).values({ jobTitle: "Director", companyName: "Example", jobDescription: "Operations", libraryVersion: 1, librarySnapshot: library, model: "test", status: "ready", revision: 1, content }).returning();
  const edit = new FormData(); edit.set("summary", "Leader");
  expect(await saveCvDraft(draft!.id, { ok: true }, edit)).toMatchObject({ ok: false, error: expect.stringContaining("the maximum is 2") });
  expect(await database.select().from(schema.cvDrafts)).toHaveLength(1);
  const response = await downloadCv(new Request("http://localhost/api/cv/pdf"), { params: Promise.resolve({ id: draft!.id }) });
  expect(response.status).toBe(422);
  const application = new FormData(); application.set("appliedOn", "2026-09-11");
  expect(await recordApplication(draft!.id, { ok: true }, application)).toMatchObject({ ok: false, error: expect.stringContaining("the maximum is 2") });
  expect(await database.select().from(schema.applications)).toHaveLength(0);
});

it("carries library styling through generation, revision, matching preview/download and immutable application bytes", async () => {
  const { AiEngine } = await import("../../../../packages/ai/src/index");
  const { handleGenerateCv } = await import("../../../worker/src/handlers/cv");
  const { GET: downloadCv } = await import("@/app/api/cv/[id]/pdf/route");
  const { POST: previewCv } = await import("@/app/api/cv/preview/route");
  const { inflateSync } = await import("node:zlib");
  const streams = (pdf: Buffer) => [...pdf.toString("latin1").matchAll(/stream\n([\s\S]*?)\nendstream/g)].map(match => {
    try { return inflateSync(Buffer.from(match[1]!, "latin1")).toString("hex"); } catch { return match[1]; }
  });
  const { job } = await fixture();
  const library = { name: "Example Candidate", contact: "London · example@example.test", linkedinUrl: "https://www.linkedin.com/in/example", profile: "Operations leader", theme: DEFAULT_CV_THEME,
    employment: [{ id: "role", company: "Example Company", industryDescriptions: "Healthcare, Software & SaaS", jobTitle: "Director", startDate: "2020", endDate: "", current: true }], entries: [
      { id: "role", employmentId: "role", kind: "experience", heading: "Director", details: "Led a team", confirmedResponsibilities: ["Led a team"] },
      { id: "skills", kind: "skill", heading: "Tools", details: "SQL and reporting", skillItems: ["SQL", "Financial planning"] },
      { id: "degree", kind: "education", heading: "BSc Economics · Example University", details: "BSc Economics, Example University." },
    ] };
  const save = new FormData(); save.set("library", JSON.stringify(library)); save.set("version", "0");
  expect(await saveCvLibrary({ ok: true }, save)).toEqual({ ok: true });
  const generate = new FormData(); generate.set("jobId", job.id); generate.set("description", "Lead operations, financial planning and reporting across the organisation. " .repeat(5));
  await expect(requestCv({ ok: true }, generate)).rejects.toThrow("redirect:/cv/");
  const [draft] = await database.select().from(schema.cvDrafts);
  const [task] = await database.select().from(schema.tasks).where(eq(schema.tasks.type, "generate_cv"));
  const model = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Operations leader with experience in planning and reporting.", sections: [
    { entryId: "role", industryDescriptions: ["Healthcare", "Software & SaaS"], bullets: ["Led a team."] },
    { entryId: "skills", bullets: ["SQL and reporting"], skillItems: ["SQL", "Financial planning"] },
    { entryId: "degree", bullets: ["BSc Economics, Example University."] },
  ], gaps: ["Review-only evidence gap"] });
  try {
    await handleGenerateCv(task!, { db: database, env: { anthropicApiKey: "fixture-key" }, settings: async () => ({ monthlyAiBudgetUsd: 100 }), now: () => new Date() } as unknown as import("../../../worker/src/context").WorkerDeps);
  } finally { model.mockRestore(); }
  const [ready] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft!.id));
  expect(ready!.status).toBe("ready");
  expect(ready!.content!.theme).toEqual(DEFAULT_CV_THEME);
  const edit = new FormData(); edit.set("summary", ready!.content!.summary); edit.set("theme", JSON.stringify({ ...DEFAULT_CV_THEME, primary: "#285447" }));
  await expect(saveCvDraft(ready!.id, { ok: true }, edit)).rejects.toThrow("redirect:/cv/");
  const [revised] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, ready!.id));
  const preview = await previewCv(new Request("http://localhost/api/cv/preview", { method: "POST", body: JSON.stringify(revised!.content) }));
  const download = await downloadCv(new Request("http://localhost/api/cv/pdf"), { params: Promise.resolve({ id: revised!.id }) });
  expect(preview.status).toBe(200); expect(download.status).toBe(200);
  expect(Number(preview.headers.get("x-cv-page-count"))).toBeLessThanOrEqual(2);
  expect(streams(Buffer.from(await preview.arrayBuffer()))).toEqual(streams(Buffer.from(await download.arrayBuffer())));
  const application = new FormData(); application.set("appliedOn", "2026-09-11");
  expect(await recordApplication(revised!.id, { ok: true }, application)).toEqual({ ok: true });
  const [frozen] = await database.select().from(schema.applications);
  edit.set("summary", "Updated wording for a future application.");
  await expect(saveCvDraft(revised!.id, { ok: true }, edit)).rejects.toThrow("redirect:/cv/");
  const stored = await downloadApplication(new Request("http://localhost/api/applications/pdf"), { params: Promise.resolve({ id: frozen!.id }) });
  expect(Buffer.from(await stored.arrayBuffer()).toString("base64")).toBe(frozen!.pdfBase64);
});

it("queues fitting from unsaved draft edits without overwriting the source or requiring it to fit first", async () => {
  const library = { name: "Example", contact: "London", profile: "Leader", entries: [{ id: "one", kind: "experience" as const, heading: "Director", details: "Led a team", confirmedResponsibilities: ["Led a team"] }] };
  const content = { name: "Example", contact: "London", summary: "Original profile", sections: [{ entryId: "one", kind: "experience" as const, heading: "Director", bullets: ["Led a team"] }], gaps: [] };
  const [draft] = await database.insert(schema.cvDrafts).values({ jobTitle: "Director", companyName: "Example", jobDescription: "Finance operations", libraryVersion: 1, librarySnapshot: library, model: "test", status: "ready", revision: 4, content }).returning();
  const edits = new FormData(); edits.set("intent", "fit"); edits.set("summary", "Current unsaved profile"); edits.set("section-0", "Led a team and reporting"); edits.set("theme", JSON.stringify({ ...DEFAULT_CV_THEME, primary: "#285447" }));
  await expect(saveCvDraft(draft!.id, { ok: true }, edits)).rejects.toThrow("redirect:/cv/");
  const [source] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft!.id));
  expect(source!.content).toEqual(content);
  const [fitting] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, draft!.id));
  expect(fitting).toMatchObject({ revision: 5, status: "queued", content: null });
  expect(fitting!.librarySnapshot.theme!.primary).toBe("#285447");
  const [task] = await database.select().from(schema.tasks).where(eq(schema.tasks.type, "generate_cv"));
  expect(task!.payload).toMatchObject({ draftId: fitting!.id, sourcePlan: { summary: "Current unsaved profile", sections: [{ entryId: "one", bullets: ["Led a team and reporting"] }] } });
});
