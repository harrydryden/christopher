import { createCvAssessment } from "@christopher/core/cv-review";
import {
  cvTextItems,
  cvClaimItems,
  cvEvidenceItems,
} from "@christopher/core/cv-assessment";
import {
  rubricFixture,
  reviewFixture,
} from "../../../../packages/core/test/cv-review-fixture";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, schema, subscribeToCompany, type Db } from "@christopher/db";
import { DEFAULT_CV_THEME, CV_THEMES } from "@christopher/core/cv";
import { DEFAULT_ACCOUNT_AI_BUDGET_USD, DEFAULT_SETTINGS, modelForCallSite } from "@christopher/core";
import { runMigrations } from "@christopher/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import { cvBuildState } from "@/lib/cv-build-state";
import { ensureTestUser, signInTestUser } from "@/test/auth";
import type { User } from "@christopher/db/schema";

async function completeAssessment(id: string) {
  const [draft] = await database
    .select()
    .from(schema.cvDrafts)
    .where(eq(schema.cvDrafts.id, id));
  const content = draft!.content!,
    library = draft!.librarySnapshot,
    rubric = rubricFixture(draft!.jobDescription);
  const review = reviewFixture({
    rubric,
    cv: cvTextItems(content),
    claims: cvClaimItems(content),
    evidence: cvEvidenceItems(library),
  });
  const assessment = createCvAssessment({
    content,
    description: draft!.jobDescription,
    library,
    rubric,
    review,
    model: "test",
    pageCount: 2,
  });
  await database
    .update(schema.cvDrafts)
    .set({ status: "ready", assessment })
    .where(eq(schema.cvDrafts.id, id));
  const form = new FormData();
  form.set("reviewed", "on");
  expect(await finaliseCvDraft(id, { ok: true }, form)).toEqual({ ok: true });
}
let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let user: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (session ? { value: session } : undefined),
  }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`);
  },
}));
import {
  savePreferenceProfile,
  savePinnedStatements,
  acceptReasonTag,
} from "./learning";
import {
  decide,
  decideRoles,
  saveDecisionTags,
  archiveRoles,
} from "./decisions";
import { recordApplication, updateApplication } from "./applications";
import { GET as workStatus } from "@/app/api/work-status/route";
import { GET as downloadApplication } from "@/app/api/applications/[id]/pdf/route";
import {
  saveCvLibrary,
  saveCvAppearance,
  saveCvWritingPreferences,
  requestCv,
  saveCvDraft,
  saveCvModel,
  finaliseCvDraft,
  assessCvDraft,
} from "./cv";
import {
  fetchRolePage,
  fetchRoleDetails,
  parseRolesFilters,
  fetchTableJobs,
  fetchRecentEventsFor,
} from "@/lib/queries/jobs";
import { saveAiBudget, saveAiSettings, saveKeywords } from "./settings";
import {
  addCompanies,
  useDiscoveryCandidate,
  refreshCompany,
} from "./companies";
import { removeCatalogueCompany, saveCatalogueCompany } from "./admin";
import { listAccounts, resetAccountAiSpend, setAccountAiBudget } from "./account";
import { accountAiBudgets } from "@/lib/queries/accounts";

beforeAll(async () => {
  const client = createDb(
    process.env.TEST_DATABASE_URL ??
      "postgres://postgres:postgres@127.0.0.1:5432/christopher_test",
  );
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "integration-test-secret";
});
afterAll(async () => {
  await pool?.end();
});
beforeEach(async () => {
  await database.execute(
    sql`truncate cv_libraries, cv_drafts, companies, decisions, tasks, settings, preference_profiles, tag_vocabulary, users restart identity cascade`,
  );
  ({ user, cookie: session } = await signInTestUser(database, process.env.SESSION_SECRET!));
});
async function fixture() {
  const [company] = await database
    .insert(schema.companies)
    .values({
      name: "Acme",
      domain: "acme.example",
      homepageUrl: "https://acme.example",
    })
    .returning();
  const [source] = await database
    .insert(schema.careerSources)
    .values({
      companyId: company!.id,
      type: "html",
      url: "https://acme.example/jobs",
    })
    .returning();
  const [job] = await database
    .insert(schema.jobs)
    .values({
      companyId: company!.id,
      sourceId: source!.id,
      title: "Operations Manager",
      normalizedTitle: "operations manager",
      externalKey: "one",
      url: "https://acme.example/jobs/one",
    })
    .returning();
  await follow(company!.id, job!.id);
  return { company: company!, job: job!, source: source! };
}
/** The signed-in account follows the company and sees the given postings in its table. */
async function follow(companyId: string, ...jobIds: string[]) {
  await subscribeToCompany(database, user.id, companyId);
  if (jobIds.length)
    await database.insert(schema.userJobs).values(jobIds.map((jobId) => ({ userId: user.id, jobId, inTable: true, keywordMatched: true, keywordTerms: ["operations"] }))).onConflictDoNothing();
}

describe("authenticated mutations", () => {
  it("refreshes known sources once and brings scheduled scans forward", async () => {
    const { company } = await fixture();
    await Promise.all([refreshCompany(company.id), refreshCompany(company.id)]);
    const [task] = await database.select().from(schema.tasks).where(eq(schema.tasks.type, "scan_company"));
    expect(task!.type).toBe("scan_company");
    const [logo] = await database.select().from(schema.tasks).where(eq(schema.tasks.type, "discover"));
    expect(logo!.payload).toMatchObject({ logoOnly: true, homepageUrl: company.homepageUrl });
    expect(await database.select().from(schema.tasks)).toHaveLength(2);
    await database
      .update(schema.tasks)
      .set({
        dedupeKey: `scan_company:${company.id}:preserved-run`,
        runAfter: new Date(Date.now() + 3600000),
        payload: {
          companyId: company.id,
          trigger: "schedule",
          scanRunId: "preserved-run",
        },
      })
      .where(eq(schema.tasks.id, task!.id));
    await refreshCompany(company.id);
    const [updated] = await database.select().from(schema.tasks).where(eq(schema.tasks.type, "scan_company"));
    expect(updated!.runAfter.getTime()).toBeLessThanOrEqual(Date.now());
    expect(updated!.payload).toMatchObject({
      trigger: "manual",
      scanRunId: "preserved-run",
    });
    expect(await database.select().from(schema.tasks)).toHaveLength(2);
  });
  it("discovers missing sources but preserves source confirmation and company pauses", async () => {
    const { company, source } = await fixture();
    await database
      .update(schema.careerSources)
      .set({ status: "needs_confirmation" })
      .where(eq(schema.careerSources.id, source.id));
    await expect(refreshCompany(company.id)).rejects.toThrow(
      `redirect:/companies/${company.id}`,
    );
    expect((await database.select().from(schema.tasks)).map(task => task.payload.logoOnly)).toEqual([true]);
    await database
      .update(schema.careerSources)
      .set({ status: "disabled" })
      .where(eq(schema.careerSources.id, source.id));
    await refreshCompany(company.id);
    expect((await database.select().from(schema.tasks))[0]!.type).toBe(
      "discover",
    );
    await database.delete(schema.tasks);
    await database
      .update(schema.companies)
      .set({ status: "paused" })
      .where(eq(schema.companies.id, company.id));
    await refreshCompany(company.id);
    expect(await database.select().from(schema.tasks)).toHaveLength(0);
    session = undefined;
    await expect(refreshCompany(company.id)).rejects.toThrow("Unauthorised");
  });

  it("corrects the homepage and domain without changing sources or roles", async () => {
    const { company, source, job } = await fixture();
    const form = new FormData();
    form.set("homepageUrl", "www.corrected.example");
    form.set("name", "Acme");
    expect(await saveCatalogueCompany(company.id, { ok: true }, form)).toEqual({
      ok: true,
    });
    const [updated] = await database
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, company.id));
    expect(updated!.homepageUrl).toBe("https://www.corrected.example/");
    expect(updated!.domain).toBe("corrected.example");
    const logoTasks = await database.select().from(schema.tasks);
    expect(logoTasks).toHaveLength(1);
    expect(logoTasks[0]!.payload).toMatchObject({
      companyId: company.id,
      logoOnly: true,
      homepageUrl: "https://www.corrected.example/",
    });
    await saveCatalogueCompany(company.id, { ok: true }, form);
    expect(await database.select().from(schema.tasks)).toHaveLength(1);
    expect((await database.select().from(schema.careerSources))[0]!.url).toBe(
      source.url,
    );
    expect((await database.select().from(schema.jobs))[0]!.id).toBe(job.id);
    form.set("homepageUrl", "javascript:alert(1)");
    expect(
      (await saveCatalogueCompany(company.id, { ok: true }, form)).ok,
    ).toBe(false);
    await database
      .insert(schema.companies)
      .values({
        name: "Other",
        domain: "other.example",
        homepageUrl: "https://other.example/",
      });
    form.set("homepageUrl", "other.example");
    expect(
      (await saveCatalogueCompany(company.id, { ok: true }, form)).ok,
    ).toBe(false);
    session = undefined;
    await expect(
      saveCatalogueCompany(company.id, { ok: true }, form),
    ).rejects.toThrow("Unauthorised");
  });
  it("rejects unauthenticated action calls before writing", async () => {
    const { job } = await fixture();
    session = undefined;
    await expect(decide(job.id, "apply", "Good fit")).rejects.toThrow(
      "Unauthorised",
    );
    expect(await database.select().from(schema.decisions)).toHaveLength(0);
  });
  it("asks an unconfirmed member to confirm before spending on AI, but never an administrator", async () => {
    const form = new FormData();
    form.set("urls", "https://gate.example");
    // The budget the gate protects is the administrator's own to set.
    await database.update(schema.users).set({ emailVerifiedAt: null }).where(eq(schema.users.id, user.id));
    await expect(addCompanies(form)).rejects.toThrow("redirect:/companies?added=1");
    await database.update(schema.users).set({ role: "member" }).where(eq(schema.users.id, user.id));
    form.set("urls", "https://gate-two.example");
    await expect(addCompanies(form)).rejects.toThrow("redirect:/account?verify=required");
    expect(await database.select().from(schema.companies)).toHaveLength(1);
    await database.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, user.id));
    await expect(addCompanies(form)).rejects.toThrow("redirect:/companies?added=1");
  });
  it("serialises competing decisions and retains history on undo", async () => {
    const { job } = await fixture();
    const results = await Promise.all([
      decide(job.id, "apply", "Good fit"),
      decide(job.id, "skip", "Too junior"),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    let rows = await database
      .select()
      .from(schema.decisions)
      .where(eq(schema.decisions.jobId, job.id));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => !r.superseded)).toHaveLength(1);
    await decide(job.id, null, "");
    rows = await database
      .select()
      .from(schema.decisions)
      .where(eq(schema.decisions.jobId, job.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.superseded)).toBe(true);
  });
  it("updates gate membership before a keyword save returns", async () => {
    const { job } = await fixture();
    const form = new FormData();
    form.set("includeKeywords", "engineering");
    await saveKeywords({ ok: true }, form);
    const [updated] = await database
      .select()
      .from(schema.userJobs)
      .where(eq(schema.userJobs.jobId, job.id));
    expect(updated!.inTable).toBe(false);
    expect(updated!.archivedAt).not.toBeNull();
  });
  it("makes concurrent repeated source confirmation idempotent", async () => {
    const { company } = await fixture();
    const [run] = await database
      .insert(schema.discoveryRuns)
      .values({
        companyId: company.id,
        status: "needs_confirmation",
        candidates: [
          {
            spec: {
              type: "greenhouse",
              url: "https://job-boards.greenhouse.io/acme",
              atsSlug: "acme",
            },
          },
        ],
      })
      .returning();
    await Promise.all([
      useDiscoveryCandidate(run!.id, 0),
      useDiscoveryCandidate(run!.id, 0),
    ]);
    const sources = await database
      .select()
      .from(schema.careerSources)
      .where(eq(schema.careerSources.type, "greenhouse"));
    expect(sources).toHaveLength(1);
  });
  it("retains decision snapshots when a company is deleted", async () => {
    const { company, job } = await fixture();
    await decide(job.id, "apply", "Good fit");
    await expect(removeCatalogueCompany(company.id)).rejects.toThrow(
      "redirect:/admin/catalogue",
    );
    expect(await database.select().from(schema.jobs)).toHaveLength(0);
    const decisions = await database
      .select()
      .from(schema.decisions)
      .where(eq(schema.decisions.companyName, "Acme"));
    expect(
      decisions.some(
        (d) => d.jobId === null && d.jobTitle === "Operations Manager",
      ),
    ).toBe(true);
  });
});

describe("learning controls", () => {
  it("creates immutable profile versions and rejects an obsolete edit", async () => {
    const first = new FormData();
    first.set("markdown", "Operations leadership in London");
    first.set("profileVersion", "0");
    await savePreferenceProfile(first);
    const second = new FormData();
    second.set("markdown", "Operations leadership, UK remote");
    second.set("profileVersion", "1");
    await savePreferenceProfile(second);
    await expect(savePreferenceProfile(second)).rejects.toThrow("changed");
    const profiles = await database
      .select()
      .from(schema.preferenceProfiles)
      .orderBy(schema.preferenceProfiles.version);
    expect(profiles.map((p) => p.markdown)).toEqual([
      "Operations leadership in London",
      "Operations leadership, UK remote",
    ]);
  });
  it("can pin preferences before any model profile exists", async () => {
    const form = new FormData();
    form.set("pinnedStatements", "No relocation.");
    form.set("profileVersion", "0");
    await savePinnedStatements(form);
    const [profile] = await database.select().from(schema.preferenceProfiles);
    expect(profile!.pinnedStatements).toEqual(["No relocation."]);
    expect(profile!.version).toBe(1);
  });
  it("requires vocabulary approval and preserves manual tag edits", async () => {
    const { job } = await fixture();
    await decide(job.id, "skip", "Too junior");
    const [decision] = await database
      .select()
      .from(schema.decisions)
      .where(eq(schema.decisions.jobId, job.id));
    await database
      .insert(schema.tagVocabulary)
      .values({ userId: user.id, tag: "seniority:overqualified", accepted: false });
    const form = new FormData();
    form.append("tags", "seniority:overqualified");
    await expect(saveDecisionTags(decision!.id, form)).rejects.toThrow(
      "accepted",
    );
    await acceptReasonTag("seniority:overqualified");
    await saveDecisionTags(decision!.id, form);
    const [updated] = await database
      .select()
      .from(schema.decisions)
      .where(eq(schema.decisions.id, decision!.id));
    expect(updated!.tags).toEqual(["seniority:overqualified"]);
    expect(updated!.tagsEdited).toBe(true);
  });
});

describe("priority workflows", () => {
  it("archives without deleting evidence, restores and synchronously applies seniority", async () => {
    const { job } = await fixture();
    expect((await fetchTableJobs(user.id)).length).toBe(1);
    expect((await archiveRoles([job.id], true)).ok).toBe(true);
    expect(await fetchTableJobs(user.id)).toHaveLength(0);
    expect(await fetchTableJobs(user.id, true)).toHaveLength(1);
    const form = new FormData();
    form.set("includeKeywords", "operations");
    form.set("seniorityKeywords", "director");
    await saveKeywords({ ok: true }, form);
    expect(await fetchTableJobs(user.id, true)).toHaveLength(1);
    await archiveRoles([job.id], false);
    expect(await fetchTableJobs(user.id)).toHaveLength(0);
    const [stored] = await database
      .select()
      .from(schema.userJobs)
      .where(eq(schema.userJobs.jobId, job.id));
    expect(stored!.archivedAt).not.toBeNull();
    expect(stored!.inTable).toBe(false);
  });
  it("reports completion without returning full company or CV records", async () => {
    const { company } = await fixture();
    const [task] = await database
      .insert(schema.tasks)
      .values({ type: "scan_company", payload: { companyId: company.id }, priority: 3 })
      .returning();
    const pending = await workStatus(
      new Request("http://localhost/api/work-status"),
    );
    expect((await pending.json()).active).toBe(true);
    await database
      .update(schema.tasks)
      .set({ status: "done" })
      .where(eq(schema.tasks.id, task!.id));
    expect(
      (
        await (
          await workStatus(new Request("http://localhost/api/work-status"))
        ).json()
      ).active,
    ).toBe(false);
  });
  it("filters and pages roles in SQL before loading descriptions", async () => {
    const { job, company, source } = await fixture();
    const inserted = await database
      .insert(schema.jobs)
      .values(
        Array.from({ length: 55 }, (_, i) => ({
          companyId: company.id,
          sourceId: source.id,
          externalKey: `page-${i}`,
          title: `Role ${String(i).padStart(2, '0')}`,
          normalizedTitle: `role ${i}`,
          url: `https://acme.example/${i}`,
          location: "London",
        })),
      )
      .returning({ id: schema.jobs.id });
    await follow(company.id, ...inserted.map((row) => row.id));
    const filters = parseRolesFilters({ q: 'Role', location: 'London', sort: 'title' });
    const first = await fetchRolePage(user.id, filters, false, null, 1);
    const second = await fetchRolePage(user.id, filters, false, null, 2);
    expect(first.total).toBe(55);
    expect(first.visible).toHaveLength(50);
    expect(second.visible).toHaveLength(5);
    expect(first.visible[0]!.job.title).toBe('Role 00');
    await decide(second.visible[0]!.job.id, 'skip', 'Not relevant');
    expect((await fetchRolePage(user.id, filters, false, null, 2)).total).toBe(54);
    expect((await fetchRolePage(user.id, { ...filters, decision: 'skip' }, false, null, 1)).visible).toHaveLength(1);
  });
  it("loads descriptions only for requested role detail IDs", async () => {
    const { job } = await fixture();
    await database.update(schema.jobs).set({ descriptionText: "Stored role description" }).where(eq(schema.jobs.id, job.id));
    const summaries = await fetchTableJobs(user.id, false, true);
    expect(summaries.find((row) => row.job.id === job.id)!.job.descriptionText).toBeNull();
    const details = await fetchRoleDetails(user.id, [job.id]);
    expect(details).toHaveLength(1);
    expect(details[0]!.job.descriptionText).toBe("Stored role description");
    expect(await fetchRoleDetails(user.id, [])).toEqual([]);
    // The page the table renders never carries the description: nothing on it renders one.
    const page = await fetchRolePage(user.id, parseRolesFilters({}), false, null, 1);
    expect(page.visible).toHaveLength(1);
    expect(page.visible[0]!.job.descriptionText).toBeNull();
    expect(JSON.stringify(page.visible)).not.toContain("Stored role description");
  });
  it("requires a reason to dismiss a role, keeps one optional to shortlist it, and retains snapshots", async () => {
    const { job, company, source } = await fixture();
    const [second] = await database.insert(schema.jobs).values({ companyId: company.id, sourceId: source.id, externalKey: "two", title: "Finance Director", normalizedTitle: "finance director", url: "https://acme.example/two" }).returning();
    await follow(company.id, second!.id);

    // Spec R-6.1: a reason is required for skip, and nothing is written without one.
    const refused = await decide(job.id, "skip", "   ");
    expect(refused).toEqual({ ok: false, error: expect.stringContaining("reason") });
    expect(await database.select().from(schema.decisions)).toHaveLength(0);

    expect((await decide(job.id, "apply", "")).ok).toBe(true);
    for (const id of [job.id, second!.id]) expect((await decide(id, "skip", "Too junior")).ok).toBe(true);
    const decisions = await database.select().from(schema.decisions).where(eq(schema.decisions.superseded, false));
    expect(decisions).toHaveLength(2);
    expect(decisions.every((d) => d.reason === "Too junior")).toBe(true);
    expect(decisions.every((d) => d.jobTitle && d.companyName === "Acme")).toBe(true);
    expect((await database.select().from(schema.tasks)).some(
        (t) => t.type === "suggest_filters")).toBe(true);
  });
  it("rolls back a decision when its learning task cannot be persisted, and reports no SQL", async () => {
    const { job } = await fixture();
    await database.execute(sql`alter table tasks add constraint audit_reject_tag_task check (type <> 'tag_reason') not valid`);
    try {
      const result = await decide(job.id, "skip", "Too junior");
      expect(result).toEqual({ ok: false, error: "Could not save your decision. Please try again." });
      // The Postgres error names a constraint, a relation and the row that broke it: none of it is shown.
      const shown = result.ok ? "" : result.error;
      for (const leak of ["constraint", "audit_reject_tag_task", "tasks", "tag_reason", "violates"]) expect(shown).not.toContain(leak);
      expect(await database.select().from(schema.decisions)).toHaveLength(0);
      expect(await database.select().from(schema.tasks)).toHaveLength(0);
    } finally {
      await database.execute(sql`alter table tasks drop constraint audit_reject_tag_task`);
    }
  });

  it("shows a message written for the person verbatim", async () => {
    // A UserFacingError is the only thing an action repeats back.
    expect(await decide(crypto.randomUUID(), "apply", "Good fit")).toEqual({ ok: false, error: "Role not found." });
  });
  it("saves legacy employment as a new library version and rejects dangling job links", async () => {
    const oldContent = { name: "Test Candidate", contact: "London", profile: "Leader", entries: [{ id: "one", kind: "experience" as const, heading: "Director · Acme", details: "Led a team" }] };
    await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: oldContent });
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
    await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: { name: "Test Candidate", contact: "London", profile: "", entries: [{ id: "one", kind: "experience", status: "active", heading: "Director · Acme", details: "An unconfirmed proposal" }] } });
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
    const [draft] = await database.insert(schema.cvDrafts).values({ userId: user.id, jobTitle: "Analyst", companyName: "Example", jobDescription: "Analysis", libraryVersion: 1, librarySnapshot: library, model: "test", status: "ready", revision: 1, content }).returning();
    const application = new FormData(); application.set("appliedOn", "2026-09-06");
    await completeAssessment(draft!.id);
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
    expect(versions.map((v) => v.content?.summary)).toEqual(["Original", "Edited summary"]);
    expect(versions[1]!.parentId).toBe(draft!.id);
    expect(versions[1]!.content?.sections[0]?.industryDescriptions).toEqual(["SaaS"]);
    const libraries = await database.select().from(schema.cvLibraries).orderBy(schema.cvLibraries.version);
    expect(libraries).toHaveLength(1);
    expect(libraries[0]!.content.preferredWording).toBeUndefined();
    const [preferences] = await database.select().from(schema.userSettings).where(eq(schema.userSettings.key, "cvWritingPreferences"));
    expect((preferences!.value as { preferredWording: string }).preferredWording).toContain("Led the operations team");
    const application = new FormData(); application.set("appliedOn", "2026-02-30");
    expect((await recordApplication(versions[1]!.id, { ok: true }, application)).ok).toBe(false);
    application.set("appliedOn", "2026-09-06");
    await completeAssessment(versions[1]!.id);
    // Corrections are remembered whichever build the save requests, and the improved revision writes with them.
    const improve = new FormData(); improve.set("summary", "Edited summary"); improve.set("section-0", "Led the operations team to record output"); improve.set("rememberWording", "on"); improve.set("intent", "improve");
    await expect(saveCvDraft(versions[1]!.id, { ok: true }, improve)).rejects.toThrow("redirect:/cv/");
    const [remembered] = await database.select().from(schema.userSettings).where(eq(schema.userSettings.key, "cvWritingPreferences"));
    expect((remembered!.value as { preferredWording: string }).preferredWording).toContain("Led the operations team to record output");
    const improving = (await database.select().from(schema.cvDrafts).orderBy(schema.cvDrafts.revision)).at(-1)!;
    expect(improving.parentId).toBe(versions[1]!.id);
    expect(improving.status).toBe("queued");
    expect(improving.librarySnapshot.preferredWording).toContain("Led the operations team to record output");
    expect((await recordApplication(versions[1]!.id, { ok: true }, application)).ok).toBe(true);
    expect((await recordApplication(versions[1]!.id, { ok: true }, application)).ok).toBe(false);
    const [savedApplication] = await database.select().from(schema.applications);
    const frozen = savedApplication!.pdfBase64!;
    expect(Buffer.from(frozen, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    const update = new FormData(); update.set("status", "interview"); update.set("notes", "First interview arranged");
    expect((await updateApplication(savedApplication!.id, { ok: true }, update)).ok).toBe(true);
    const [after] = await database.select().from(schema.applications);
    expect(after!.history.map((h) => h.status)).toEqual(["applied", "interview"]);
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
  it("rejects a model ID outside the supported list", async () => {
    // A dotted version passed the old regex, was stored, and then failed on every call.
    const form = new FormData(); form.set("cvModel", "claude-fable-5.1");
    expect((await saveCvModel({ ok: true }, form)).ok).toBe(false);
  });
});

it("queues an explicit board URL even while homepage discovery is pending", async () => {
  const { company } = await fixture();
  await database.insert(schema.tasks).values({ type: "discover", payload: { companyId: company.id }, dedupeKey: `discover:${company.id}`,
    });
  const { pasteDiscoveryUrl } = await import("./companies");
  const form = new FormData();
  form.set("url", "https://job-boards.greenhouse.io/acme");
  await pasteDiscoveryUrl(company.id, form);
  const tasks = await database
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.type, "discover"));
  expect(tasks).toHaveLength(2);
  expect(
    tasks.some((t) =>
      (t.payload as { url?: string }).url?.includes("greenhouse"),
    ),
  ).toBe(true);
});

it("returns only the newest requested events per role", async () => {
  const { job } = await fixture();
  await database
    .insert(schema.jobEvents)
    .values(
      Array.from({ length: 30 }, (_, i) => ({
        jobId: job.id,
        type: "updated" as const,
        payload: { i },
        at: new Date(1700000000000 + i * 1000),
      })),
    );
  const events = await fetchRecentEventsFor(user.id, [job.id], 3);
  expect(events.get(job.id)!.map((e) => e.payload.i)).toEqual([29, 28, 27]);
});

it("atomically adds 1,000 companies and queues setup, with a bounded response for duplicate imports", async () => {
  const form = new FormData();
  form.set(
    "urls",
    Array.from({ length: 1000 }, (_, n) => `https://bulk${n}.example`).join(
      "\n",
    ),
  );
  await expect(addCompanies(form)).rejects.toThrow("redirect:/companies?added=1000");
  expect(await database.select({id:schema.companies.id}).from(schema.companies)).toHaveLength(1000);
  expect(await database.select({id:schema.tasks.id}).from(schema.tasks).where(eq(schema.tasks.type,"discover"))).toHaveLength(1000);
  await expect(addCompanies(form)).rejects.toThrow("added=0");
  expect(await database.select({id:schema.tasks.id}).from(schema.tasks)).toHaveLength(1000);
});

describe("four-status role workflow", () => {
  it("keeps counts, filtered pages and export selection aligned across transitions", async () => {
    const { fetchRoleCounts, applyRolesFilters } = await import("@/lib/queries/jobs");
    const { listCompanies } = await import("@/lib/queries/companies");
    const { job, company } = await fixture();
    const read = async (view: string) => fetchRolePage(user.id, parseRolesFilters({ view }), view === "archived", 99, 1);
    expect((await read("auto-matched")).total).toBe(1);
    expect((await decide(job.id, "apply", "")).ok).toBe(true);
    await database.update(schema.jobs).set({ status: "closed" }).where(eq(schema.jobs.id, job.id));
    await database.update(schema.userJobs).set({ inTable: false, fitScore: 1 }).where(eq(schema.userJobs.jobId, job.id));
    expect((await read("auto-matched")).total).toBe(0);
    expect((await read("user-shortlisted")).total).toBe(1);
    expect((await fetchRoleCounts(user.id, company.id))["user-shortlisted"]).toBe(1);
    const [summary] = await listCompanies(user.id);
    expect(summary!.reviewRoles).toBe(0); expect(summary!.shortlistedRoles).toBe(1);
    const exported = applyRolesFilters(await fetchTableJobs(user.id, false, true), parseRolesFilters({ view: "user-shortlisted" }));
    expect(exported.map((row) => row.job.id)).toEqual([job.id]);
    expect((await archiveRoles([job.id], true)).ok).toBe(true);
    expect((await read("archived")).total).toBe(1);
    expect((await read("user-shortlisted")).total).toBe(0);
    expect((await archiveRoles([job.id], false)).ok).toBe(true);
    expect((await read("user-shortlisted")).total).toBe(1);
    expect((await decide(job.id, "skip", "Wrong seniority")).ok).toBe(true);
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
    await database.update(schema.userJobs).set({ inTable: false }).where(eq(schema.userJobs.jobId, job.id));
    await archiveNonMatches(database, { userId: user.id });
    await archiveNonMatches(database, { userId: user.id });
    const events = await database.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, job.id));
    expect(events.filter((event) => event.payload.action === "archived")).toHaveLength(1);
    expect(events[0]!.payload.reason).toBe("No longer matches your criteria");
    await database.update(schema.userJobs).set({ inTable: true }).where(eq(schema.userJobs.jobId, job.id));
    expect((await archiveRoles([job.id], false)).ok).toBe(true);
    expect((await fetchRolePage(user.id, parseRolesFilters({}), false, null, 1)).total).toBe(1);
  });
});

describe("CSV export", () => {
  it("streams every filtered role, with no description column and none read", async () => {
    const { GET: exportCsv } = await import("@/app/api/export.csv/route");
    const { NextRequest } = await import("next/server");
    const { company, source, job } = await fixture();
    await database.update(schema.jobs).set({ descriptionText: "x".repeat(30_000), location: "London" }).where(eq(schema.jobs.id, job.id));
    const inserted = await database.insert(schema.jobs).values(Array.from({ length: 120 }, (_, i) => ({
      companyId: company.id, sourceId: source.id, externalKey: `csv-${i}`, title: `Role ${i}`,
      normalizedTitle: `role ${i}`, url: `https://acme.example/csv/${i}`, descriptionText: "y".repeat(30_000),
    }))).returning({ id: schema.jobs.id });
    await follow(company.id, ...inserted.map((row) => row.id));

    const response = await exportCsv(new NextRequest("https://example.test/api/export.csv?decision=all"));
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const csv = await response.text();
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("company,website,role,location,url,live_for_days,availability,fit,status,reason,first_seen,posted_at,closed_at");
    // Every row, in blocks, and not one character of the stored descriptions.
    expect(lines).toHaveLength(122);
    expect(csv).not.toContain("xxxx");
    expect(csv).not.toContain("yyyy");
    expect(csv).toContain("Operations Manager");
  }, 120_000);
});

describe("retired filter suggestions", () => {
  it("settles a stored hide-threshold suggestion instead of failing, and applies a keyword one", async () => {
    const { acceptFilterSuggestion } = await import("./learning");
    const [legacy] = await database.insert(schema.filterSuggestions)
      .values({ userId: user.id, type: "hide_threshold", value: { threshold: 40 }, rationale: "from before" }).returning();
    // Accept on a page opened before automatic score hiding was retired must not throw.
    await expect(acceptFilterSuggestion(legacy!.id)).resolves.toBeUndefined();
    const [settled] = await database.select().from(schema.filterSuggestions).where(eq(schema.filterSuggestions.id, legacy!.id));
    expect(settled!.status).toBe("rejected");
    expect(settled!.resolvedAt).toBeInstanceOf(Date);

    const [keyword] = await database.insert(schema.filterSuggestions)
      .values({ userId: user.id, type: "keyword_include", value: { term: "chief of staff" }, rationale: "two applies" }).returning();
    await acceptFilterSuggestion(keyword!.id);
    const [applied] = await database.select().from(schema.filterSuggestions).where(eq(schema.filterSuggestions.id, keyword!.id));
    expect(applied!.status).toBe("accepted");
    const { getSettingsFor } = await import("@/lib/settings");
    expect((await getSettingsFor(user.id)).gate.includeKeywords).toContain("chief of staff");
  });

  it("describes a stored hide-threshold row as retired", async () => {
    const { describeFilterSuggestion } = await import("@/lib/filterSuggestions");
    expect(describeFilterSuggestion({ type: "hide_threshold", value: { threshold: 40 } })).toBe("Automatic score hiding (retired)");
  });
});

describe("bulk archive", () => {
  it("archives and restores 500 roles in one set of statements, with the same rows, events and errors", async () => {
    const { company, source, job } = await fixture();
    const inserted = await database.insert(schema.jobs).values(Array.from({ length: 499 }, (_, i) => ({
      companyId: company.id, sourceId: source.id, externalKey: `bulk-${i}`, title: `Bulk ${i}`,
      normalizedTitle: `bulk ${i}`, url: `https://acme.example/bulk/${i}`,
    }))).returning({ id: schema.jobs.id });
    await follow(company.id, ...inserted.map((row) => row.id));
    const ids = [job.id, ...inserted.map((row) => row.id)];
    expect(ids).toHaveLength(500);

    expect(await archiveRoles(ids, true)).toEqual({ ok: true });
    const archived = await database.select().from(schema.userJobs);
    expect(archived).toHaveLength(500);
    expect(archived.every((view) => view.archivedAt instanceof Date)).toBe(true);
    const events = await database.select().from(schema.jobEvents);
    expect(events).toHaveLength(500);
    expect(events.every((event) => event.type === "updated" && event.userId === user.id)).toBe(true);
    expect(events.every((event) => event.payload.action === "archived" && event.payload.actor === "user")).toBe(true);
    expect(new Set(events.map((event) => event.jobId)).size).toBe(500);

    expect(await archiveRoles(ids, false)).toEqual({ ok: true });
    expect((await database.select().from(schema.userJobs)).every((view) => view.archivedAt === null)).toBe(true);
    const restored = (await database.select().from(schema.jobEvents)).filter((event) => event.payload.action === "restored");
    expect(restored).toHaveLength(500);
    expect(new Set(restored.map((event) => event.jobId)).size).toBe(500);

    // The error messages are what they always were, and nothing is written when one is returned.
    expect(await archiveRoles([...ids.slice(0, 3), crypto.randomUUID()], true)).toEqual({ ok: false, error: "A selected role no longer exists." });
    expect((await database.select().from(schema.userJobs)).every((view) => view.archivedAt === null)).toBe(true);
    await database.update(schema.userJobs).set({ inTable: false }).where(eq(schema.userJobs.jobId, job.id));
    expect(await archiveRoles([job.id], false)).toEqual({ ok: false, error: "This role no longer matches your criteria. Review it and shortlist it to bring it back, or update your matching preferences." });
    expect(await archiveRoles([], true)).toEqual({ ok: false, error: "Select between 1 and 500 roles." });
  }, 120_000);
});

describe("bulk decisions", () => {
  /** 100 roles this account follows, the first of them already decided. */
  async function hundredRoles() {
    const { company, source, job } = await fixture();
    const inserted = await database.insert(schema.jobs).values(Array.from({ length: 99 }, (_, i) => ({
      companyId: company.id, sourceId: source.id, externalKey: `group-${i}`, title: `Group ${i}`,
      normalizedTitle: `group ${i}`, url: `https://acme.example/group/${i}`,
    }))).returning({ id: schema.jobs.id });
    await follow(company.id, ...inserted.map((row) => row.id));
    return { ids: [job.id, ...inserted.map((row) => row.id)], first: job.id };
  }
  const taskKeys = async () => (await database.select().from(schema.tasks)).map((task) => ({ type: task.type, dedupeKey: task.dedupeKey }));

  it("decides 100 roles at once exactly as 100 single decisions would", async () => {
    const { ids, first } = await hundredRoles();
    expect(ids).toHaveLength(100);

    // The baseline: one role decided on its own, and the tasks that decision leaves behind.
    expect((await decide(first, "apply", "Shared reason")).ok).toBe(true);
    const singleTaskTypes = [...new Set((await taskKeys()).map((task) => task.type))].sort();
    expect(singleTaskTypes).toEqual(["score_job", "suggest_filters", "synthesize_profile", "tag_reason"]);
    // Clear what the baseline wrote, so what follows is the group's own work alone.
    await database.execute(sql`delete from tasks`);
    await database.execute(sql`delete from job_events`);

    expect(await decideRoles(ids, "apply", "  Shared reason  ")).toEqual({ ok: true });

    const rows = await database.select().from(schema.decisions);
    expect(rows).toHaveLength(101);
    const active = rows.filter((row) => !row.superseded);
    expect(active).toHaveLength(100);
    expect(new Set(active.map((row) => row.jobId))).toEqual(new Set(ids));
    expect(active.every((row) => row.decision === "apply" && row.reason === "Shared reason")).toBe(true);
    // The snapshot a single decision writes is written here too.
    expect(active.every((row) => row.jobTitle && row.companyName === "Acme")).toBe(true);
    const superseded = rows.filter((row) => row.superseded);
    expect(superseded.map((row) => row.jobId)).toEqual([first]);

    const decided = (await database.select().from(schema.jobEvents)).filter((event) => event.type === "decided" && event.payload.decision === "apply");
    expect(decided).toHaveLength(100);
    expect(new Set(decided.map((event) => event.jobId))).toEqual(new Set(ids));
    expect(decided.every((event) => event.userId === user.id && event.payload.reason === "Shared reason")).toBe(true);

    // Exactly the tasks the same roles decided one at a time would queue: one per role where the
    // dedupe key names a role or a decision, one per account where it names the account.
    const tasks = await taskKeys();
    expect([...new Set(tasks.map((task) => task.type))].sort()).toEqual(singleTaskTypes);
    expect(new Set(tasks.filter((task) => task.type === "score_job").map((task) => task.dedupeKey)))
      .toEqual(new Set(ids.map((id) => `score_job:${user.id}:${id}`)));
    expect(new Set(tasks.filter((task) => task.type === "tag_reason").map((task) => task.dedupeKey)))
      .toEqual(new Set(active.map((row) => `tag_reason:${row.id}`)));
    expect(tasks.filter((task) => task.type === "synthesize_profile")).toHaveLength(1);
    expect(tasks.filter((task) => task.type === "suggest_filters")).toHaveLength(1);

    // Undoing the group supersedes every one of them and keeps the audit record.
    expect(await decideRoles(ids, null, "")).toEqual({ ok: true });
    expect((await database.select().from(schema.decisions)).every((row) => row.superseded)).toBe(true);
    expect((await database.select().from(schema.jobEvents)).filter((event) => event.type === "decided" && event.payload.decision === null)).toHaveLength(100);
  }, 120_000);

  it("refuses the whole group, writing nothing, when the reason, an id or the count is wrong", async () => {
    const { ids } = await hundredRoles();
    const clean = async () => {
      expect(await database.select().from(schema.decisions)).toHaveLength(0);
      expect(await database.select().from(schema.tasks)).toHaveLength(0);
      expect((await database.select().from(schema.jobEvents)).filter((event) => event.type === "decided")).toHaveLength(0);
    };

    // Spec R-6.1 applies to the group: a blank shared reason dismisses nothing.
    expect(await decideRoles(ids, "skip", "   ")).toEqual({ ok: false, error: expect.stringContaining("reason") });
    await clean();

    // All or nothing: one id that is not this account's view fails the group.
    const [outside] = await database.insert(schema.companies).values({ name: "Other", domain: "other.example", homepageUrl: "https://other.example" }).returning();
    const [outsideSource] = await database.insert(schema.careerSources).values({ companyId: outside!.id, type: "html", url: "https://other.example/jobs" }).returning();
    const [unfollowed] = await database.insert(schema.jobs).values({ companyId: outside!.id, sourceId: outsideSource!.id, externalKey: "outside", title: "Outside", normalizedTitle: "outside", url: "https://other.example/jobs/1" }).returning();
    for (const stranger of [unfollowed!.id, crypto.randomUUID()]) {
      expect(await decideRoles([...ids.slice(0, 5), stranger], "apply", "Shared reason")).toEqual({ ok: false, error: "A selected role no longer exists." });
      await clean();
    }

    expect(await decideRoles([...ids, unfollowed!.id], "apply", "Shared reason")).toEqual({ ok: false, error: "Select between 1 and 100 roles." });
    expect(await decideRoles([], "apply", "")).toEqual({ ok: false, error: "Select between 1 and 100 roles." });
    await clean();

    // Every group mutation authenticates at the action boundary (R-6.12).
    session = undefined;
    await expect(decideRoles(ids.slice(0, 2), "apply", "Shared reason")).rejects.toThrow("Unauthorised");
    await clean();
  }, 120_000);
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

it("queues oversized edits for automatic fitting, permits previews and protects final downloads", async () => {
  const { GET: downloadCv } = await import("@/app/api/cv/[id]/pdf/route");
  const library = { name: "Example", contact: "London", profile: "Leader", entries: [{ id: "one", kind: "experience" as const, heading: "Director", details: "Led a team" }] };
  const content = { name: "Example", contact: "London", summary: "Leader", sections: Array.from({ length: 5 }, (_, i) => ({ entryId: String(i), kind: "experience" as const, heading: `Director ${i}`,
      bullets: Array.from({ length: 6 }, () =>
        "Managed operational planning and reporting. ".repeat(14),
      ),
    })),
    gaps: [],
  };
  const [draft] = await database
    .insert(schema.cvDrafts)
    .values({
      userId: user.id, jobTitle: "Director",
      companyName: "Example",
      jobDescription: "Operations",
      libraryVersion: 1,
      librarySnapshot: library,
      model: "test",
      status: "ready",
      revision: 1,
      content,
    })
    .returning();
  const edit = new FormData();
  edit.set("summary", "Leader");
  await expect(saveCvDraft(draft!.id, { ok: true }, edit)).rejects.toThrow("redirect:/cv/");
  const revisions = await database.select().from(schema.cvDrafts);
  expect(revisions).toHaveLength(2);
  const child = revisions.find(row => row.parentId === draft!.id)!;
  expect(child).toMatchObject({ status: "queued", content: { ...content, sections: content.sections.map(section => ({ ...section, bullets: section.bullets.map(bullet => bullet.trim()) })) } });
  const [task] = await database.select().from(schema.tasks).where(eq(schema.tasks.type, "generate_cv"));
  expect(task!.payload).toMatchObject({ draftId: child.id, mode: "assess" });
  const response = await downloadCv(
    new Request("http://localhost/api/cv/pdf"),
    { params: Promise.resolve({ id: draft!.id }) },
  );
  expect(response.status).toBe(409);
  const preview = await downloadCv(
    new Request("http://localhost/api/cv/pdf?preview=1"),
    { params: Promise.resolve({ id: draft!.id }) },
  );
  expect(preview.status).toBe(200);
  const application = new FormData();
  application.set("appliedOn", "2026-09-11");
  expect(
    await recordApplication(draft!.id, { ok: true }, application),
  ).toMatchObject({ ok: false, error: expect.stringContaining("finalise") });
  expect(await database.select().from(schema.applications)).toHaveLength(0);
});

it("carries library styling through generation, revision, matching preview/download and immutable application bytes", async () => {
  const { AiEngine } = await import("../../../../packages/ai/src/index");
  vi.spyOn(AiEngine.prototype, "analyseCvJob").mockImplementation(
    async (description) => rubricFixture(description),
  );
  vi.spyOn(AiEngine.prototype, "assessCv").mockImplementation(async (input) =>
    reviewFixture(input),
  );
  const { handleGenerateCv } = await import("../../../worker/src/handlers/cv");
  const { GET: downloadCv } = await import("@/app/api/cv/[id]/pdf/route");
  const { POST: previewCv } = await import("@/app/api/cv/preview/route");
  const { inflateSync } = await import("node:zlib");
  const streams = (pdf: Buffer) =>
    [...pdf.toString("latin1").matchAll(/stream\n([\s\S]*?)\nendstream/g)].map(
      (match) => {
        try {
          return inflateSync(Buffer.from(match[1]!, "latin1")).toString("hex");
        } catch {
          return match[1];
        }
      },
    );
  const { job } = await fixture();
  const library = {
    name: "Example Candidate",
    contact: "London · example@example.test",
    linkedinUrl: "https://www.linkedin.com/in/example",
    profile: "Operations leader",
    theme: DEFAULT_CV_THEME,
    employment: [
      {
        id: "role",
        company: "Example Company",
        industryDescriptions: "Healthcare, Software & SaaS",
        jobTitle: "Director",
        startDate: "2020",
        endDate: "",
        current: true,
      },
    ],
    entries: [
      {
        id: "role",
        employmentId: "role",
        kind: "experience",
        heading: "Director",
        details: "Led a team",
        confirmedResponsibilities: ["Led a team"],
      },
      {
        id: "skills",
        kind: "skill",
        heading: "Tools",
        details: "SQL and reporting",
        skillItems: ["SQL", "Financial planning"],
      },
      {
        id: "degree",
        kind: "education",
        heading: "BSc Economics · Example University",
        details: "BSc Economics, Example University.",
      },
    ],
  };
  const save = new FormData();
  save.set("library", JSON.stringify(library));
  save.set("version", "0");
  expect(await saveCvLibrary({ ok: true }, save)).toEqual({ ok: true });
  const generate = new FormData();
  generate.set("jobId", job.id);
  generate.set(
    "description",
    "Lead operations, financial planning and reporting across the organisation. ".repeat(
      5,
    ),
  );
  await expect(requestCv({ ok: true }, generate)).rejects.toThrow(
    "redirect:/cv/",
  );
  const [draft] = await database.select().from(schema.cvDrafts);
  const [task] = await database
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.type, "generate_cv"));
  const model = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({
    summary: "Operations leader with experience in planning and reporting.",
    sections: [
      {
        entryId: "role",
        industryDescriptions: ["Healthcare", "Software & SaaS"],
        bullets: ["Led a team."],
      },
      {
        entryId: "skills",
        bullets: ["SQL and reporting"],
        skillItems: ["SQL", "Financial planning"],
      },
      { entryId: "degree", bullets: ["BSc Economics, Example University."] },
    ],
    gaps: ["Review-only evidence gap"],
  });
  try {
    await handleGenerateCv(task!, {
      db: database,
      env: { anthropicApiKey: "fixture-key" },
      userSettings: async () => ({ aiBudgetUsd: 100, aiBudgetResetAt: null }),
      now: () => new Date(),
    } as unknown as import("../../../worker/src/context").WorkerDeps);
  } finally {
    model.mockRestore();
  }
  const [ready] = await database
    .select()
    .from(schema.cvDrafts)
    .where(eq(schema.cvDrafts.id, draft!.id));
  expect(ready!.status).toBe("ready");
  expect(ready!.content!.theme).toEqual(DEFAULT_CV_THEME);
  const edit = new FormData();
  edit.set("summary", ready!.content!.summary);
  edit.set(
    "theme",
    JSON.stringify({ ...DEFAULT_CV_THEME, primary: "#285447" }),
  );
  await expect(saveCvDraft(ready!.id, { ok: true }, edit)).rejects.toThrow(
    "redirect:/cv/",
  );
  const [revised] = await database
    .select()
    .from(schema.cvDrafts)
    .where(eq(schema.cvDrafts.parentId, ready!.id));
  await completeAssessment(revised!.id);
  const preview = await previewCv(
    new Request("http://localhost/api/cv/preview", {
      method: "POST",
      body: JSON.stringify(revised!.content),
    }),
  );
  const download = await downloadCv(
    new Request("http://localhost/api/cv/pdf"),
    { params: Promise.resolve({ id: revised!.id }) },
  );
  expect(preview.status).toBe(200);
  expect(download.status).toBe(200);
  expect(Number(preview.headers.get("x-cv-page-count"))).toBeLessThanOrEqual(2);
  expect(streams(Buffer.from(await preview.arrayBuffer()))).toEqual(
    streams(Buffer.from(await download.arrayBuffer())),
  );
  const application = new FormData();
  application.set("appliedOn", "2026-09-11");
  await completeAssessment(revised!.id);
  expect(
    await recordApplication(revised!.id, { ok: true }, application),
  ).toEqual({ ok: true });
  const [frozen] = await database.select().from(schema.applications);
  edit.set("summary", "Updated wording for a future application.");
  await expect(saveCvDraft(revised!.id, { ok: true }, edit)).rejects.toThrow(
    "redirect:/cv/",
  );
  const stored = await downloadApplication(
    new Request("http://localhost/api/applications/pdf"),
    { params: Promise.resolve({ id: frozen!.id }) },
  );
  expect(Buffer.from(await stored.arrayBuffer()).toString("base64")).toBe(
    frozen!.pdfBase64,
  );
});

it("queues a rebuild from unsaved draft edits without overwriting the source or requiring it to fit first", async () => {
  const library = {
    name: "Example",
    contact: "London",
    profile: "Leader",
    entries: [
      {
        id: "one",
        kind: "experience" as const,
        heading: "Director",
        details: "Led a team",
        confirmedResponsibilities: ["Led a team"],
      },
    ],
  };
  const content = {
    name: "Example",
    contact: "London",
    summary: "Original profile",
    sections: [
      {
        entryId: "one",
        kind: "experience" as const,
        heading: "Director",
        bullets: ["Led a team"],
      },
    ],
    gaps: [],
  };
  const [draft] = await database
    .insert(schema.cvDrafts)
    .values({
      userId: user.id, jobTitle: "Director",
      companyName: "Example",
      jobDescription: "Finance operations",
      libraryVersion: 1,
      librarySnapshot: library,
      model: "test",
      status: "ready",
      revision: 4,
      content,
    })
    .returning();
  const edits = new FormData();
  edits.set("intent", "improve");
  edits.set("summary", "Current unsaved profile");
  edits.set("section-0", "Led a team and reporting");
  edits.set(
    "theme",
    JSON.stringify({ ...DEFAULT_CV_THEME, primary: "#285447" }),
  );
  await expect(saveCvDraft(draft!.id, { ok: true }, edits)).rejects.toThrow(
    "redirect:/cv/",
  );
  const [source] = await database
    .select()
    .from(schema.cvDrafts)
    .where(eq(schema.cvDrafts.id, draft!.id));
  expect(source!.content).toEqual(content);
  const [fitting] = await database
    .select()
    .from(schema.cvDrafts)
    .where(eq(schema.cvDrafts.parentId, draft!.id));
  expect(fitting).toMatchObject({
    revision: 5,
    status: "queued",
    content: null,
  });
  expect(fitting!.librarySnapshot.theme!.primary).toBe("#285447");
  const [task] = await database
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.type, "generate_cv"));
  // A rebuild starts from the Library: the unsaved wording is not carried into it.
  expect(task!.payload).toMatchObject({ draftId: fitting!.id, mode: "improve" });
  expect(task!.payload).not.toHaveProperty("sourcePlan");
});

it("assesses, improves with current evidence, finalises and exports through the real revision workflow", async () => {
  const { AiEngine } = await import("../../../../packages/ai/src/index");
  const { handleGenerateCv } = await import("../../../worker/src/handlers/cv");
  const { GET: downloadCv } = await import("@/app/api/cv/[id]/pdf/route");
  const { job } = await fixture();
  const library = {
    name: "Example",
    contact: "London",
    profile: "Operations leader",
    entries: [
      {
        id: "role",
        kind: "experience" as const,
        heading: "Director",
        details: "Led operations",
        confirmedResponsibilities: ["Led operations"],
      },
      {
        id: "skills",
        kind: "skill" as const,
        heading: "Tools",
        details: "SQL",
        skillItems: ["SQL"],
      },
    ],
  };
  await database
    .insert(schema.cvLibraries)
    .values({ userId: user.id, version: 1, content: library });
  const description =
    "Must lead operations. SQL is desirable. The role works with finance teams to improve reliable reporting and planning.";
  const rubric = {
    requirements: [
      {
        id: "r1",
        label: "Lead operations",
        quote: "Must lead operations.",
        importance: "essential" as const,
        category: "experience" as const,
      },
      {
        id: "r2",
        label: "SQL",
        quote: "SQL is desirable.",
        importance: "desirable" as const,
        category: "skills" as const,
      },
    ],
    caveats: [],
  };
  const analyse = vi
    .spyOn(AiEngine.prototype, "analyseCvJob")
    .mockResolvedValue(rubric);
  const writer = vi
    .spyOn(AiEngine.prototype, "buildCv")
    .mockImplementation(async () => ({
      summary: "Operations leader",
      sections: [
        { entryId: "role", bullets: ["Led operations"] },
        ...(writer.mock.calls.length > 1
          ? [{ entryId: "skills", bullets: ["SQL"], skillItems: ["SQL"] }]
          : []),
      ],
      gaps: [],
    }));
  const reviewer = vi
    .spyOn(AiEngine.prototype, "assessCv")
    .mockImplementation(async (input) => {
      const result = reviewFixture(input);
      const sql = input.cv.find((item) => item.text === "SQL");
      Object.assign(result.matches[1]!, {
        status: sql ? "demonstrated" : "missing",
        cvEvidence: sql ? [{ id: sql.id, quote: "SQL" }] : [],
        libraryEvidence: [{ id: "entry:skills", quote: "SQL" }],
        improvement: "Include the confirmed SQL skill in the skills section.",
      });
      return result;
    });
  const deps = {
    db: database,
    env: { anthropicApiKey: "fixture-key" },
    userSettings: async () => ({ aiBudgetUsd: 100, aiBudgetResetAt: null }),
    now: () => new Date(),
  } as unknown as import("../../../worker/src/context").WorkerDeps;
  async function run(id: string) {
    const [task] = await database
      .select()
      .from(schema.tasks)
      .where(sql`payload->>'draftId' = ${id}`)
      .orderBy(schema.tasks.createdAt);
    await handleGenerateCv(task!, deps);
    await database
      .update(schema.tasks)
      .set({ status: "done" })
      .where(eq(schema.tasks.id, task!.id));
    return (
      await database
        .select()
        .from(schema.cvDrafts)
        .where(eq(schema.cvDrafts.id, id))
    )[0]!;
  }
  try {
    const form = new FormData();
    form.set("jobId", job.id);
    form.set("description", description);
    await expect(requestCv({ ok: true }, form)).rejects.toThrow(
      "redirect:/cv/",
    );
    const first = (await database.select().from(schema.cvDrafts))[0]!;
    const ready = await run(first.id);
    expect(ready.status).toBe("ready");
    expect(ready.assessment!.score).toBe(67);
    expect(ready.jobSource!.kind).toBe("user_supplied");
    expect(ready.finalisedAt).toBeNull();
    const endpoint = () => ({ params: Promise.resolve({ id: ready.id }) });
    expect(
      (await downloadCv(new Request("http://localhost/api/cv/pdf"), endpoint()))
        .status,
    ).toBe(409);
    expect(
      (
        await downloadCv(
          new Request("http://localhost/api/cv/pdf?preview=1"),
          endpoint(),
        )
      ).status,
    ).toBe(200);
    await database
      .insert(schema.cvLibraries)
      .values({
        userId: user.id, version: 2,
        content: { ...library, profile: "Operations and reporting leader" },
      });
    await database
      .update(schema.jobs)
      .set({ descriptionText: "Changed upstream description" })
      .where(eq(schema.jobs.id, job.id));
    const improve = new FormData();
    improve.set("summary", ready.content!.summary);
    improve.set("intent", "improve");
    await expect(saveCvDraft(ready.id, { ok: true }, improve)).rejects.toThrow(
      "redirect:/cv/",
    );
    const child = (
      await database
        .select()
        .from(schema.cvDrafts)
        .where(eq(schema.cvDrafts.parentId, ready.id))
    )[0]!;
    expect(child.libraryVersion).toBe(2);
    expect(child.jobDescription).toBe(description);
    expect(child.assessment).toBeNull();
    expect(child.finalisedAt).toBeNull();
    const improved = await run(child.id);
    expect(improved.assessment!.score).toBe(100);
    expect(analyse).toHaveBeenCalledTimes(1);
    expect(writer.mock.calls[1]![0].improvements).toContain(
      "Include the confirmed SQL skill in the skills section.",
    );
    const approve = new FormData();
    expect((await finaliseCvDraft(child.id, { ok: true }, approve)).ok).toBe(
      false,
    );
    approve.set("reviewed", "on");
    expect(await finaliseCvDraft(child.id, { ok: true }, approve)).toEqual({
      ok: true,
    });
    expect(
      (
        await downloadCv(new Request("http://localhost/api/cv/pdf"), {
          params: Promise.resolve({ id: child.id }),
        })
      ).status,
    ).toBe(200);
    const application = new FormData();
    application.set("appliedOn", "2026-09-12");
    expect(
      await recordApplication(child.id, { ok: true }, application),
    ).toEqual({ ok: true });
    const frozen = (await database.select().from(schema.applications))[0]!;
    const edit = new FormData();
    edit.set("summary", "Operations and reporting leader");
    await expect(saveCvDraft(child.id, { ok: true }, edit)).rejects.toThrow(
      "redirect:/cv/",
    );
    const revised = (
      await database
        .select()
        .from(schema.cvDrafts)
        .where(eq(schema.cvDrafts.parentId, child.id))
    )[0]!;
    expect(revised.assessment).toBeNull();
    expect(revised.finalisedAt).toBeNull();
    const reviewed = await run(revised.id);
    expect(reviewed.status).toBe("ready");
    expect(writer).toHaveBeenCalledTimes(2);
    expect(reviewer).toHaveBeenCalledTimes(3);
    expect(
      (await database.select().from(schema.applications))[0]!.pdfBase64,
    ).toBe(frozen.pdfBase64);
  } finally {
    analyse.mockRestore();
    writer.mockRestore();
    reviewer.mockRestore();
  }
});

it("requires the original advert when a stored description was model-rewritten or truncated", async () => {
  const { job } = await fixture();
  await database
    .insert(schema.cvLibraries)
    .values({
      userId: user.id, version: 1,
      content: {
        name: "Example",
        contact: "",
        profile: "Analyst",
        entries: [
          {
            id: "s",
            kind: "skill",
            heading: "Tools",
            details: "SQL",
            skillItems: ["SQL"],
          },
        ],
      },
    });
  await database
    .update(schema.jobs)
    .set({
      descriptionSource: "model",
      descriptionText:
        "Lead operational planning, financial reporting and work with company leadership to improve delivery.",
    })
    .where(eq(schema.jobs.id, job.id));
  const form = new FormData();
  form.set("jobId", job.id);
  expect(await requestCv({ ok: true }, form)).toMatchObject({
    ok: false,
    error: expect.stringContaining("original company advert"),
  });
  await database
    .update(schema.jobs)
    .set({ descriptionSource: "direct", descriptionTruncated: true })
    .where(eq(schema.jobs.id, job.id));
  expect((await requestCv({ ok: true }, form)).ok).toBe(false);
  expect(await database.select().from(schema.cvDrafts)).toHaveLength(0);
  form.set(
    "description",
    "Lead operational planning, financial reporting and work with company leadership to improve delivery. SQL is desirable.",
  );
  await expect(requestCv({ ok: true }, form)).rejects.toThrow("redirect:/cv/");
  expect(
    (await database.select().from(schema.cvDrafts))[0]!.jobSource!.method,
  ).toBe("pasted");
});
it("does not strand an assessment retry while the previous task is still finishing", async () => {
  const library = {
    name: "Example",
    contact: "",
    profile: "Analyst",
    entries: [
      {
        id: "s",
        kind: "skill" as const,
        heading: "Tools",
        details: "SQL",
        skillItems: ["SQL"],
      },
    ],
  };
  const [draft] = await database
    .insert(schema.cvDrafts)
    .values({
      userId: user.id, jobTitle: "Analyst",
      companyName: "Example",
      jobDescription: "Use SQL",
      libraryVersion: 1,
      librarySnapshot: library,
      model: "test",
      status: "failed",
    })
    .returning();
  await database
    .insert(schema.tasks)
    .values({
      type: "generate_cv",
      status: "running",
      payload: { draftId: draft!.id },
      dedupeKey: `generate_cv:${draft!.id}`,
    });
  expect(
    await assessCvDraft(draft!.id, { ok: true }, new FormData()),
  ).toMatchObject({
    ok: false,
    error: expect.stringContaining("still finishing"),
  });
  expect((await database.select().from(schema.cvDrafts))[0]!.status).toBe(
    "failed",
  );
});

/** One role, one job's worth of evidence: enough for a build to be asked for and refused. */
const rebuildLibrary = {
  name: "Example",
  contact: "London",
  profile: "Leader",
  entries: [
    {
      id: "one",
      kind: "experience" as const,
      heading: "Director",
      details: "Led a team",
      confirmedResponsibilities: ["Led a team"],
    },
  ],
};
const rebuildContent = {
  name: "Example",
  contact: "London",
  summary: "Original profile",
  sections: [
    { entryId: "one", kind: "experience" as const, heading: "Director", bullets: ["Led a team"] },
  ],
  gaps: [],
};

it("starts a rebuild clean of the attempt it replaces, and starts it once", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: rebuildLibrary });
  // The parent spent every attempt on something the system was resolving, and left behind what it
  // had already paid for and the record of why it stopped.
  const [parent] = await database
    .insert(schema.cvDrafts)
    .values({
      userId: user.id, jobTitle: "Director", companyName: "Example", jobDescription: "Finance operations",
      libraryVersion: 1, librarySnapshot: rebuildLibrary, model: "test", status: "failed", revision: 3,
      content: rebuildContent,
      progressAt: new Date(Date.now() - 20 * 60_000),
      buildCheckpoint: { rubricAt: new Date(Date.now() - 25 * 60_000).toISOString(), attempt: 3 },
      error: "The model provider is overloaded.",
      failure: {
        kind: "overloaded", resolvedBy: "system", retryable: true,
        message: "The model provider is overloaded.", motion: "write", attempt: 3, maxAttempts: 3,
      },
    })
    .returning();
  const rebuild = () => {
    const form = new FormData();
    form.set("intent", "improve");
    form.set("summary", rebuildContent.summary);
    form.set("section-0", "Led a team");
    return form;
  };

  // Two clicks on Rebuild from Library, as fast as the browser can send them.
  const attempts = await Promise.allSettled([
    saveCvDraft(parent!.id, { ok: true }, rebuild()),
    saveCvDraft(parent!.id, { ok: true }, rebuild()),
  ]);
  const outcomes = attempts.map((attempt) =>
    attempt.status === "rejected" ? String((attempt.reason as Error).message) : attempt.value,
  );
  expect(outcomes.filter((outcome) => typeof outcome === "string" && outcome.startsWith("redirect:/cv/"))).toHaveLength(1);
  expect(outcomes).toContainEqual({ ok: false, error: "This CV is already being rebuilt." });

  const children = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, parent!.id));
  expect(children).toHaveLength(1);
  expect(await database.select().from(schema.tasks).where(eq(schema.tasks.type, "generate_cv"))).toHaveLength(1);

  // Nothing of the parent's build comes with it: this revision has never run.
  const child = children[0]!;
  expect(child).toMatchObject({ status: "queued", progressAt: null, buildCheckpoint: null, failure: null, error: null });
  const [queued] = await database.select().from(schema.tasks).where(eq(schema.tasks.dedupeKey, `generate_cv:${child.id}`));
  const state = cvBuildState(child, {
    status: queued!.status, attempts: queued!.attempts, maxAttempts: queued!.maxAttempts,
    error: queued!.error, startedAt: queued!.startedAt,
  }, new Date());
  // Which is what the page says about it — not "attempt 3 stopped, retrying attempt 4 of 3".
  expect(state).toMatchObject({ phase: "waiting", message: "Waiting for the worker.", title: null, resumeNote: null, taskError: null });
});

it("sends a second Generate to the build already running rather than starting another", async () => {
  const { job } = await fixture();
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: rebuildLibrary });
  const generate = () => {
    const form = new FormData();
    form.set("jobId", job.id);
    form.set("description", "Lead a business operations team, develop the annual operating plan and work with finance and commercial leaders.");
    return form;
  };
  const clicks = await Promise.allSettled([requestCv({ ok: true }, generate()), requestCv({ ok: true }, generate())]);

  const drafts = await database.select().from(schema.cvDrafts);
  expect(drafts).toHaveLength(1);
  expect(await database.select().from(schema.tasks).where(eq(schema.tasks.type, "generate_cv"))).toHaveLength(1);
  // Both clicks land on the build that is running; neither starts a second one to pay for.
  expect(clicks.map((click) => (click.status === "rejected" ? String((click.reason as Error).message) : click.value))).toEqual([
    `redirect:/cv/${drafts[0]!.id}`,
    `redirect:/cv/${drafts[0]!.id}`,
  ]);
});

it("retries a page-limit failure against the Library and the settings as they are now", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: rebuildLibrary });
  const snapshot = { ...rebuildLibrary, theme: { ...DEFAULT_CV_THEME, maxPages: 2 } };
  const failed = {
    userId: user.id, jobTitle: "Director", companyName: "Example", jobDescription: "Finance operations",
    libraryVersion: 1, librarySnapshot: snapshot, model: "test", status: "failed" as const, content: rebuildContent,
    buildCheckpoint: { contentAt: new Date().toISOString(), attempt: 1 },
  };
  const [draft] = await database
    .insert(schema.cvDrafts)
    .values({
      ...failed,
      error: "The CV is 3 pages after three attempts; the limit is 2.",
      failure: {
        kind: "page_limit_unfittable", resolvedBy: "user", retryable: false, action: "shorten_or_raise_pages",
        message: "The CV is 3 pages after three attempts; the limit is 2. Remove some evidence in your Library or raise the page limit in Settings.",
        motion: "shorten", attempt: 1, maxAttempts: 3,
      },
    })
    .returning();

  // The person does what the failure asked: raises the page limit, and tidies the Library.
  const appearance = new FormData();
  appearance.set("theme", JSON.stringify({ ...DEFAULT_CV_THEME, maxPages: 4 }));
  expect(await saveCvAppearance({ ok: true }, appearance)).toEqual({ ok: true });
  await database.insert(schema.cvLibraries).values({
    userId: user.id, version: 2, content: { ...rebuildLibrary, profile: "Operations leader" },
  });

  expect(await assessCvDraft(draft!.id, { ok: true }, new FormData())).toEqual({ ok: true });
  const [retried] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft!.id));
  // The frozen snapshot is why the retry could not have succeeded; it is the one thing replaced.
  expect(retried!.librarySnapshot.theme!.maxPages).toBe(4);
  expect(retried!.librarySnapshot.profile).toBe("Operations leader");
  expect(retried!.libraryVersion).toBe(2);
  expect(retried!.buildCheckpoint).toBeNull();
  expect(retried!.failure).toBeNull();
  expect(retried!.status).toBe("queued");
  // The wording is the person's, and a retry that rewrites it without being asked is a different bug.
  expect(retried!.content).toEqual(rebuildContent);
  const [task] = await database.select().from(schema.tasks).where(eq(schema.tasks.dedupeKey, `generate_cv:${draft!.id}`));
  expect(task!.payload).toMatchObject({ draftId: draft!.id, mode: "assess" });

  // A failure the system was already resolving changes nothing: that retry can succeed as it is,
  // and the evidence and theme this revision was written against stay with it.
  const [ordinary] = await database
    .insert(schema.cvDrafts)
    .values({
      ...failed,
      error: "The model provider is overloaded.",
      failure: {
        kind: "overloaded", resolvedBy: "system", retryable: true,
        message: "The model provider is overloaded.", motion: "write", attempt: 3, maxAttempts: 3,
      },
    })
    .returning();
  expect(await assessCvDraft(ordinary!.id, { ok: true }, new FormData())).toEqual({ ok: true });
  const [requeued] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, ordinary!.id));
  expect(requeued!.librarySnapshot).toEqual(snapshot);
  expect(requeued!.libraryVersion).toBe(1);
  expect(requeued!.status).toBe("queued");
});


it("publishes real CV stage changes to the page refresher", async () => {
  const [draft] = await database.insert(schema.cvDrafts).values({ userId: user.id, jobTitle: "Director", companyName: "Example", jobDescription: "Lead a team", libraryVersion: 1, librarySnapshot: { name: "Example", contact: "", profile: "Leader", entries: [] }, model: "test", status: "generating", buildStage: "writing" }).returning();
  const request = () => new Request(`http://localhost/api/work-status?cv=${draft!.id}`);
  const version = async () => ((await (await workStatus(request())).json()) as { active: boolean; version: string }).version;
  const writing = await version();
  expect(writing).toContain("generating:writing");
  await database.update(schema.cvDrafts).set({ buildStage: "fitting" }).where(eq(schema.cvDrafts.id, draft!.id));
  const fitting = await version();
  expect(fitting).toContain("generating:fitting");
  expect(fitting).not.toBe(writing);
  // The version also carries how long the build has been still, so a page waiting on a build that
  // has stopped moving still refreshes and its "no progress for N minutes" keeps counting.
  await database.update(schema.cvDrafts).set({ progressAt: new Date(Date.now() - 12 * 60_000) }).where(eq(schema.cvDrafts.id, draft!.id));
  expect(await version()).not.toBe(fitting);
});

it("saves default appearance independently of library edits and existing CVs", async () => {
  const { getDefaultCvAppearance } = await import("@/lib/cv-appearance");
  expect(await getDefaultCvAppearance(user.id)).toEqual(DEFAULT_CV_THEME);
  const { job } = await fixture();
  const content = { name: "Example", contact: "London", profile: "Operations leader", theme: CV_THEMES.Plum!, entries: [{ id: "skill", kind: "skill" as const, heading: "Skills", details: "Operations leadership", skillItems: ["Operations"] }] };
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content });
  expect(await getDefaultCvAppearance(user.id)).toEqual(CV_THEMES.Plum);
  const form = new FormData(); form.set("theme", JSON.stringify(CV_THEMES.Forest));
  expect(await saveCvAppearance({ ok: true }, form)).toEqual({ ok: true });
  expect(await getDefaultCvAppearance(user.id)).toEqual(CV_THEMES.Forest);
  expect((await database.select().from(schema.cvLibraries))[0]!.content).toEqual(content);
  const generate = new FormData(); generate.set("jobId", job.id);
  generate.set("description", "Lead a business operations team, develop the annual operating plan and work with finance and commercial leaders.");
  await expect(requestCv({ ok: true }, generate)).rejects.toThrow("redirect:/cv/");
  const [draft] = await database.select().from(schema.cvDrafts);
  expect(draft!.librarySnapshot.theme).toEqual(CV_THEMES.Forest);
  form.set("theme", JSON.stringify(CV_THEMES.Gold));
  expect(await saveCvAppearance({ ok: true }, form)).toEqual({ ok: true });
  expect((await database.select().from(schema.cvDrafts))[0]!.librarySnapshot.theme).toEqual(CV_THEMES.Forest);
  form.set("theme", JSON.stringify({ ...CV_THEMES.Gold, primary: "invalid" }));
  expect((await saveCvAppearance({ ok: true }, form)).ok).toBe(false);
  expect(await getDefaultCvAppearance(user.id)).toEqual(CV_THEMES.Gold);
  session = undefined;
  await expect(saveCvAppearance({ ok: true }, form)).rejects.toThrow("Unauthorised");
});


it("preserves legacy writing preferences, rejects stale saves, and uses saved preferences in new CVs", async () => {
  const { getCvWritingPreferences } = await import("@/lib/cv-writing-preferences");
  const { job } = await fixture();
  const content = { name: "Example", contact: "London", profile: "Leader", websiteUrl: "https://example.com/portfolio", stylePreferences: "Concise UK English", preferredWording: "Led the team", entries: [{ id: "skill", kind: "skill" as const, heading: "Skills", details: "Operations" }] };
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content });
  const before = await getCvWritingPreferences(user.id);
  expect(before).toEqual({ stylePreferences: content.stylePreferences, preferredWording: content.preferredWording });
  const form = new FormData();
  form.set("previousPreferences", JSON.stringify(before));
  form.set("stylePreferences", "Plain, concise UK English");
  form.set("preferredWording", "Managed the team");
  expect(await saveCvWritingPreferences({ ok: true }, form)).toEqual({ ok: true });
  expect((await saveCvWritingPreferences({ ok: true }, form)).ok).toBe(false);
  const saved = await getCvWritingPreferences(user.id);
  expect(saved.stylePreferences).toBe("Plain, concise UK English");
  expect((await database.select().from(schema.cvLibraries))).toHaveLength(1);
  const generate = new FormData(); generate.set("jobId", job.id); generate.set("description", "Lead a business operations team, develop the annual operating plan and work with finance and commercial leaders.");
  await expect(requestCv({ ok: true }, generate)).rejects.toThrow("redirect:/cv/");
  const [draft] = await database.select().from(schema.cvDrafts);
  expect(draft!.librarySnapshot).toMatchObject({ ...saved, websiteUrl: content.websiteUrl });
  form.set("previousPreferences", JSON.stringify(saved));
  form.set("stylePreferences", "x".repeat(4001));
  expect((await saveCvWritingPreferences({ ok: true }, form)).ok).toBe(false);
  expect(await getCvWritingPreferences(user.id)).toEqual(saved);
  session = undefined;
  await expect(saveCvWritingPreferences({ ok: true }, form)).rejects.toThrow("Unauthorised");
});


describe("administering accounts", () => {
  /** A finished build, an archived finished build, or one that never finished. */
  const draft = (userId: string, status: "ready" | "failed", archivedAt: Date | null = null) => ({
    userId, jobTitle: "Operations Manager", companyName: "Acme", jobDescription: "Run operations.",
    libraryVersion: 1, librarySnapshot: { name: "Example", contact: "", profile: "", entries: [] },
    model: "test", status, archivedAt,
  });
  const budgetForm = (value: string) => {
    const form = new FormData();
    form.set("aiBudgetUsd", value);
    return form;
  };
  const stored = async (userId: string, key: string) => {
    const [row] = await database.select().from(schema.userSettings)
      .where(and(eq(schema.userSettings.userId, userId), eq(schema.userSettings.key, key)));
    return row?.value;
  };

  it("counts each account's finished CVs and followed companies, and what it has spent of its budget", async () => {
    const member = await ensureTestUser(database, "member@example.com", "member");
    const { company } = await fixture();
    const [second] = await database.insert(schema.companies)
      .values({ name: "Other", domain: "other.example", homepageUrl: "https://other.example" }).returning();
    // The member follows one board and has stopped following the other.
    await database.insert(schema.companySubscriptions).values([
      { userId: member.id, companyId: company.id },
      { userId: member.id, companyId: second!.id, status: "archived" },
    ]);
    // Archiving a CV does not unmake it; a build that never finished was never produced.
    await database.insert(schema.cvDrafts).values([draft(member.id, "ready"), draft(member.id, "ready", new Date()), draft(member.id, "failed")]);
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    await database.insert(schema.aiCalls).values([
      { userId: member.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 4, at: monthStart },
      // Shared work belongs to no account's budget, and last month is over.
      { userId: null, callSite: "A3", model: "claude-sonnet-5", costUsd: 7, at: monthStart },
      { userId: member.id, callSite: "A5", model: "claude-sonnet-5", costUsd: 8, at: new Date(monthStart.getTime() - 1_000) },
    ]);

    const accounts = await listAccounts();
    // The signed-in administrator holds the one live session; the member has never signed in.
    expect(accounts.find((account) => account.id === member.id)).toMatchObject({ cvsProduced: 2, companies: 1, sessions: 0 });
    expect(accounts.find((account) => account.id === user.id)).toMatchObject({ cvsProduced: 0, companies: 1, sessions: 1 });
    const budgets = await accountAiBudgets(accounts.map((account) => account.id), now);
    expect(budgets.get(member.id)).toMatchObject({ limitUsd: DEFAULT_ACCOUNT_AI_BUDGET_USD, spentUsd: 4, countingSince: null });
    expect(budgets.get(user.id)).toMatchObject({ spentUsd: 0 });
  });

  it("lets an administrator raise and reset one account's AI budget, and refuses a member", async () => {
    const member = await ensureTestUser(database, "member@example.com", "member");
    await setAccountAiBudget(member.id, budgetForm("40"));
    expect(await stored(member.id, "aiBudgetUsd")).toBe(40);
    // Blank, negative, over the ceiling or not a number: refused, and the stored budget stands.
    for (const bad of ["", "-1", "10001", "abc"]) {
      await expect(setAccountAiBudget(member.id, budgetForm(bad))).rejects.toThrow(/between \$0 and \$10000/);
    }
    expect(await stored(member.id, "aiBudgetUsd")).toBe(40);

    await resetAccountAiSpend(member.id);
    const marker = Date.parse(String(await stored(member.id, "aiBudgetResetAt")));
    expect(marker).toBeGreaterThan(Date.now() - 60_000);
    expect(marker).toBeLessThanOrEqual(Date.now());
    // Spend recorded before the reset stops counting; the calls themselves are untouched.
    await database.insert(schema.aiCalls).values({ userId: member.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 4, at: new Date(marker - 60_000) });
    expect((await accountAiBudgets([member.id])).get(member.id)).toMatchObject({ limitUsd: 40, spentUsd: 0 });
    expect(await database.select().from(schema.aiCalls)).toHaveLength(1);

    // Another account's budget is an administrator's to set, as is resetting its spend.
    await database.update(schema.users).set({ role: "member" }).where(eq(schema.users.id, user.id));
    await expect(listAccounts()).rejects.toThrow("Forbidden");
    await expect(setAccountAiBudget(member.id, budgetForm("60"))).rejects.toThrow("Forbidden");
    await expect(setAccountAiBudget(user.id, budgetForm("60"))).rejects.toThrow("Forbidden");
    await expect(resetAccountAiSpend(member.id)).rejects.toThrow("Forbidden");
    expect(await stored(member.id, "aiBudgetUsd")).toBe(40);
    session = undefined;
    await expect(setAccountAiBudget(member.id, budgetForm("60"))).rejects.toThrow("Unauthorised");
  });

  it("lets any account set its own monthly AI budget, within bounds", async () => {
    // The budget is the account's own, so no administrator is needed to change it.
    await database.update(schema.users).set({ role: "member" }).where(eq(schema.users.id, user.id));
    expect(await saveAiBudget({ ok: true }, budgetForm("40"))).toEqual({ ok: true });
    expect(await stored(user.id, "aiBudgetUsd")).toBe(40);
    // Blank, negative, over the ceiling or not a number: refused inline, and the saved figure stands.
    for (const bad of ["", "-1", "10001", "abc"]) {
      expect(await saveAiBudget({ ok: true }, budgetForm(bad))).toMatchObject({ ok: false });
    }
    expect(await stored(user.id, "aiBudgetUsd")).toBe(40);
    // It is one's own budget and nobody else's: signed out, there is no account to set.
    session = undefined;
    await expect(saveAiBudget({ ok: true }, budgetForm("60"))).rejects.toThrow("Unauthorised");
  });

  it("saves the shared AI settings, which no longer hold a budget", async () => {
    const form = new FormData();
    form.set("defaultModel", DEFAULT_SETTINGS.defaultModel);
    // A budget posted with them is not a system setting and is not stored as one.
    form.set("monthlyAiBudgetUsd", "500");
    expect(await saveAiSettings({ ok: true }, form)).toEqual({ ok: true });
    const keys = (await database.select().from(schema.settings)).map((row) => row.key);
    expect(keys).toContain("defaultModel");
    expect(keys).not.toContain("monthlyAiBudgetUsd");
    // The shared model list stays an administrator's.
    await database.update(schema.users).set({ role: "member" }).where(eq(schema.users.id, user.id));
    await expect(saveAiSettings({ ok: true }, form)).rejects.toThrow("Forbidden");
  });
});
