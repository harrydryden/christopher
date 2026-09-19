/**
 * The applications table's writes, against the database.
 *
 * One company-role keeps one application row: the first status set from the table creates it,
 * building a CV creates it, and recording a submitted CV upgrades whichever of those is already
 * there rather than adding a second. Withdrawing is also a decision, so it leaves one.
 */
import { createCvAssessment } from "@christopher/core/cv-review";
import { cvTextItems, cvClaimItems, cvEvidenceItems } from "@christopher/core/cv-assessment";
import { rubricFixture, reviewFixture } from "../../../../packages/core/test/cv-review-fixture";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, subscribeToCompany, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { and, desc, eq, sql } from "drizzle-orm";
import { signInTestUser } from "@/test/auth";
import type { User } from "@christopher/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let user: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (session ? { value: session } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

import { manageRoleCv, recordApplication, setRoleStage, updateApplication } from "./applications";
import { decide } from "./decisions";
import { finaliseCvDraft, requestCv, saveCvLibrary } from "./cv";
import { GET as cvRedirect } from "@/app/(app)/cv/route";
import { GET as workStatus } from "@/app/api/work-status/route";

const DESCRIPTION =
  "Lead a business operations team, develop the annual operating plan and work with finance and commercial leaders.";
const LIBRARY = {
  name: "Test Candidate",
  contact: "London",
  profile: "Operations leader",
  employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2023-08", endDate: "", current: true }],
  entries: [{ id: "one", kind: "experience" as const, employmentId: "job", heading: "Leadership", details: "Led an operations team", confirmedResponsibilities: ["Led an operations team"] }],
};

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "integration-test-secret";
}, 120_000);
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate cv_libraries, cv_drafts, companies, decisions, tasks, settings, user_settings, users restart identity cascade`);
  ({ user, cookie: session } = await signInTestUser(database, process.env.SESSION_SECRET!));
});

/** A followed company with one posting this account can see. */
async function fixture() {
  const [company] = await database.insert(schema.companies).values({ name: "Acme", domain: "acme.example", homepageUrl: "https://acme.example" }).returning();
  const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://acme.example/jobs" }).returning();
  const [job] = await database.insert(schema.jobs).values({
    companyId: company!.id, sourceId: source!.id, title: "Operations Manager", normalizedTitle: "operations manager",
    externalKey: "one", url: "https://acme.example/jobs/one", descriptionText: DESCRIPTION, descriptionSource: "direct",
  }).returning();
  await subscribeToCompany(database, user.id, company!.id);
  await database.insert(schema.userJobs).values({ userId: user.id, jobId: job!.id, inTable: true, keywordMatched: true });
  return { company: company!, job: job! };
}

const applicationsOf = () =>
  database.select().from(schema.applications).where(eq(schema.applications.userId, user.id)).orderBy(desc(schema.applications.createdAt));

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

/** The library the CV builder needs, saved the way the Library page saves it. */
async function saveLibrary() {
  expect((await saveCvLibrary({ ok: true }, form({ library: JSON.stringify(LIBRARY), version: "0" }))).ok).toBe(true);
}

/** Assess and finalise a ready draft, which is what `recordApplication` insists on. */
async function completeAssessment(id: string) {
  const [draft] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, id));
  const content = draft!.content!, library = draft!.librarySnapshot, rubric = rubricFixture(draft!.jobDescription);
  const review = reviewFixture({ rubric, cv: cvTextItems(content), claims: cvClaimItems(content), evidence: cvEvidenceItems(library) });
  const assessment = createCvAssessment({ content, description: draft!.jobDescription, library, rubric, review, model: "test", pageCount: 2 });
  await database.update(schema.cvDrafts).set({ status: "ready", assessment }).where(eq(schema.cvDrafts.id, id));
  expect(await finaliseCvDraft(id, { ok: true }, form({ reviewed: "on" }))).toEqual({ ok: true });
}

it("creates the role's application row on the first status set from the table, then updates it", async () => {
  const { job } = await fixture();
  // A CV already built for the role is the revision the stage is about.
  const [draft] = await database.insert(schema.cvDrafts).values({
    userId: user.id, jobId: job.id, jobTitle: job.title, companyName: "Acme", jobDescription: DESCRIPTION,
    libraryVersion: 1, librarySnapshot: LIBRARY, model: "test", status: "ready", revision: 1,
  }).returning();

  expect(await setRoleStage(job.id, { ok: true }, form({ status: "applied", appliedOn: "2026-09-03", notes: "Applied on their site" }))).toEqual({ ok: true });
  const [created] = await applicationsOf();
  expect(created).toMatchObject({ jobId: job.id, jobTitle: "Operations Manager", companyName: "Acme", status: "applied", appliedOn: "2026-09-03", notes: "Applied on their site", cvId: draft!.id, pdfBase64: null });
  expect(created!.history.map((entry) => entry.status)).toEqual(["applied"]);

  expect(await setRoleStage(job.id, { ok: true }, form({ status: "interview", appliedOn: "2026-09-03", notes: "First round" }))).toEqual({ ok: true });
  const rows = await applicationsOf();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("interview");
  expect(rows[0]!.history.map((entry) => entry.status)).toEqual(["applied", "interview"]);

  // The stage means nothing without a date once something has been submitted, and a status this
  // build does not know is not a status.
  expect((await setRoleStage(job.id, { ok: true }, form({ status: "interview", appliedOn: "", notes: "" }))).ok).toBe(false);
  expect((await setRoleStage(job.id, { ok: true }, form({ status: "hired", appliedOn: "2026-09-03" }))).ok).toBe(false);
  expect((await setRoleStage(job.id, { ok: true }, form({ status: "applied", appliedOn: "2026-02-30" }))).ok).toBe(false);
  expect((await setRoleStage(crypto.randomUUID(), { ok: true }, form({ status: "applied", appliedOn: "2026-09-03" })))).toEqual({ ok: false, error: "Role not found." });
  expect(await applicationsOf()).toHaveLength(1);
});

it("asks before walking a row backwards, and writes nothing when nothing changed", async () => {
  const { job } = await fixture();
  expect(await setRoleStage(job.id, { ok: true }, form({ status: "offer", appliedOn: "2026-09-03", notes: "Offer made" }))).toEqual({ ok: true });

  // Back from Offer (In process) to Applied is a step down the lifecycle, and an outcome on
  // record is never rewritten silently: without the row's own confirmation it is refused.
  expect(await setRoleStage(job.id, { ok: true }, form({ status: "applied", appliedOn: "2026-09-03", notes: "Offer made" }))).toEqual({
    ok: false, error: "Confirm the move from Offer back to Applied before saving it.",
  });
  let [unmoved] = await applicationsOf();
  expect(unmoved!.status).toBe("offer");
  expect(unmoved!.history).toHaveLength(1);

  // Screening, Interview and Offer are one stage, so moving between them is not backwards.
  expect(await setRoleStage(job.id, { ok: true }, form({ status: "screening", appliedOn: "2026-09-03", notes: "Back to screening" }))).toEqual({ ok: true });
  expect(await setRoleStage(job.id, { ok: true }, form({ status: "offer", appliedOn: "2026-09-03", notes: "Offer again" }))).toEqual({ ok: true });

  // With the confirmation the row sends, the move is made and recorded like any other.
  expect(await setRoleStage(job.id, { ok: true }, form({ status: "applied", appliedOn: "2026-09-03", notes: "Offer withdrawn", confirm: "1" }))).toEqual({ ok: true });
  const [moved] = await applicationsOf();
  expect(moved!.status).toBe("applied");
  expect(moved!.history.map((entry) => entry.status)).toEqual(["offer", "screening", "offer", "applied"]);

  // Saving the same status, date and notes again is not an event: no write, no history entry.
  expect(await setRoleStage(job.id, { ok: true }, form({ status: "applied", appliedOn: "2026-09-03", notes: "Offer withdrawn" }))).toEqual({ ok: true });
  [unmoved] = await applicationsOf();
  expect(unmoved!.history).toHaveLength(4);
  // One character of notes is a change, and is recorded.
  expect(await setRoleStage(job.id, { ok: true }, form({ status: "applied", appliedOn: "2026-09-03", notes: "Offer withdrawn." }))).toEqual({ ok: true });
  expect((await applicationsOf())[0]!.history).toHaveLength(5);
});

it("applies the same two rules to a row with no posting behind it", async () => {
  const [legacy] = await database.insert(schema.applications).values({
    userId: user.id, jobId: null, jobTitle: "Legacy Role", companyName: "Legacy Co", appliedOn: "2026-08-01",
    status: "interview", notes: "Booked", history: [{ status: "interview", at: "2026-08-01T09:00:00.000Z", notes: "Booked" }],
  }).returning();
  expect(await updateApplication(legacy!.id, { ok: true }, form({ status: "applied", appliedOn: "2026-08-01", notes: "Booked" }))).toEqual({
    ok: false, error: "Confirm the move from Interview back to Applied before saving it.",
  });
  expect(await updateApplication(legacy!.id, { ok: true }, form({ status: "interview", appliedOn: "2026-08-01", notes: "Booked" }))).toEqual({ ok: true });
  expect((await applicationsOf())[0]!.history).toHaveLength(1);
  expect(await updateApplication(legacy!.id, { ok: true }, form({ status: "applied", appliedOn: "2026-08-01", notes: "Booked", confirm: "1" }))).toEqual({ ok: true });
  const [moved] = await applicationsOf();
  expect(moved!.status).toBe("applied");
  expect(moved!.history.map((entry) => entry.status)).toEqual(["interview", "applied"]);
});

it("records a skip decision when a role is withdrawn, so it leaves the shortlist", async () => {
  const { job } = await fixture();
  await database.insert(schema.decisions).values({ userId: user.id, jobId: job.id, decision: "apply", reason: "", jobTitle: job.title, companyName: "Acme" });
  expect(await setRoleStage(job.id, { ok: true }, form({ status: "withdrawn", appliedOn: "2026-09-03", notes: "Took another offer" }))).toEqual({ ok: true });
  const active = await database.select().from(schema.decisions)
    .where(and(eq(schema.decisions.userId, user.id), eq(schema.decisions.jobId, job.id), eq(schema.decisions.superseded, false)));
  expect(active.map((row) => [row.decision, row.reason])).toEqual([["skip", "Withdrawn from application"]]);
  const [row] = await applicationsOf();
  expect(row!.status).toBe("withdrawn");
});

it("withdraws a live application when the role is dismissed from Roles, and leaves an outcome alone", async () => {
  const { job } = await fixture();
  expect(await setRoleStage(job.id, { ok: true }, form({ status: "interview", appliedOn: "2026-09-03", notes: "" }))).toEqual({ ok: true });
  expect(await decide(job.id, "skip", "Not for me after all")).toEqual({ ok: true });
  const [live] = await applicationsOf();
  expect(live!.status).toBe("withdrawn");
  expect(live!.history.map((entry) => entry.status)).toEqual(["interview", "withdrawn"]);
  expect(live!.history.at(-1)!.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  // An outcome already reached is history: dismissing the role afterwards does not rewrite it.
  await database.update(schema.applications).set({ status: "accepted" }).where(eq(schema.applications.id, live!.id));
  expect(await decide(job.id, "apply", "")).toEqual({ ok: true });
  expect(await decide(job.id, "skip", "Changed my mind")).toEqual({ ok: true });
  const [settled] = await applicationsOf();
  expect(settled!.status).toBe("accepted");
  expect(settled!.history).toHaveLength(2);
});

it("answers a CV action with the row as the table should now show it", async () => {
  const { job } = await fixture();
  await database.insert(schema.decisions).values({ userId: user.id, jobId: job.id, decision: "apply", reason: "", jobTitle: job.title, companyName: "Acme" });
  const [current] = await database.insert(schema.cvDrafts).values({
    userId: user.id, jobId: job.id, jobTitle: job.title, companyName: "Acme", jobDescription: DESCRIPTION,
    libraryVersion: 1, librarySnapshot: LIBRARY, model: "test", status: "ready", revision: 1,
  }).returning();

  const archived = await manageRoleCv(job.id, current!.id, "archive");
  expect(archived.ok).toBe(true);
  if (!archived.ok) return;
  expect(archived.row).toMatchObject({ jobId: job.id, cv: null, archivedCvId: current!.id, stage: "shortlisted" });

  const restored = await manageRoleCv(job.id, current!.id, "restore");
  expect(restored.ok && restored.row?.cv?.id).toBe(current!.id);
  expect(restored.ok && restored.row?.stage).toBe("applying");

  const deleted = await manageRoleCv(job.id, current!.id, "delete");
  expect(deleted.ok && deleted.row).toMatchObject({ cv: null, archivedCvId: null, stage: "shortlisted" });
  expect(await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.userId, user.id))).toHaveLength(0);

  // A row with no posting behind it has no row to answer with; the caller refreshes instead.
  const [legacy] = await database.insert(schema.cvDrafts).values({
    userId: user.id, jobId: null, jobTitle: "Old role", companyName: "Gone Ltd", jobDescription: DESCRIPTION,
    libraryVersion: 1, librarySnapshot: LIBRARY, model: "test", status: "ready", revision: 1,
  }).returning();
  expect(await manageRoleCv(null, legacy!.id, "archive")).toEqual({ ok: true, row: null });
  expect(await manageRoleCv(job.id, legacy!.id, "shred")).toEqual({ ok: false, error: "Choose Archive, Restore or Delete." });
});

it("upgrades the role's existing application when the submitted CV is recorded, rather than adding one", async () => {
  const { job } = await fixture();
  await saveLibrary();
  await expect(requestCv({ ok: true }, form({ jobId: job.id, description: DESCRIPTION }))).rejects.toThrow("redirect:/cv/");
  const [draft] = await database.select().from(schema.cvDrafts);
  // Building a CV is the start of applying, and it is one row, written once.
  const [applying] = await applicationsOf();
  expect(applying).toMatchObject({ jobId: job.id, status: "applying", cvId: null, pdfBase64: null });
  expect(applying!.history.map((entry) => entry.status)).toEqual(["applying"]);
  await expect(requestCv({ ok: true }, form({ jobId: job.id, description: DESCRIPTION }))).rejects.toThrow(`redirect:/cv/${draft!.id}`);
  expect(await applicationsOf()).toHaveLength(1);

  await database.update(schema.cvDrafts).set({
    status: "ready",
    content: { name: "Test Candidate", contact: "London", summary: "Operations leader", sections: [{ entryId: "one", kind: "experience", heading: "Director · Acme", bullets: ["Led an operations team"] }], gaps: [] },
  }).where(eq(schema.cvDrafts.id, draft!.id));
  await completeAssessment(draft!.id);

  expect(await recordApplication(draft!.id, { ok: true }, form({ appliedOn: "2026-09-06", notes: "Sent" }))).toEqual({ ok: true });
  const rows = await applicationsOf();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.id).toBe(applying!.id);
  expect(rows[0]!.status).toBe("applied");
  expect(rows[0]!.cvId).toBe(draft!.id);
  expect(rows[0]!.appliedOn).toBe("2026-09-06");
  expect(Buffer.from(rows[0]!.pdfBase64!, "base64").subarray(0, 5).toString()).toBe("%PDF-");
  expect(rows[0]!.history.map((entry) => entry.status)).toEqual(["applying", "applied"]);

  // Only a row that already stores the bytes is a duplicate.
  expect((await recordApplication(draft!.id, { ok: true }, form({ appliedOn: "2026-09-06" })))).toEqual({
    ok: false, error: "This CV revision already has an application record.",
  });
  expect(await applicationsOf()).toHaveLength(1);

  // A status set afterwards keeps the frozen PDF and the revision it came from.
  expect(await setRoleStage(job.id, { ok: true }, form({ status: "offer", appliedOn: "2026-09-06", notes: "" }))).toEqual({ ok: true });
  const [after] = await applicationsOf();
  expect(after!.pdfBase64).toBe(rows[0]!.pdfBase64);
  expect(after!.cvId).toBe(draft!.id);
});

it("keeps a row with no posting behind it editable by id", async () => {
  const [legacy] = await database.insert(schema.applications).values({
    userId: user.id, jobId: null, jobTitle: "Legacy Role", companyName: "Legacy Co", appliedOn: "2026-08-01",
    status: "applied", history: [{ status: "applied", at: "2026-08-01T09:00:00.000Z", notes: "" }],
  }).returning();
  expect(await updateApplication(legacy!.id, { ok: true }, form({ status: "screening", notes: "Call booked", appliedOn: "2026-08-02" }))).toEqual({ ok: true });
  const [row] = await applicationsOf();
  expect(row).toMatchObject({ status: "screening", notes: "Call booked", appliedOn: "2026-08-02" });
  expect(row!.history.map((entry) => entry.status)).toEqual(["applied", "screening"]);
});

it("tells the applications table that one of its CVs is still being written", async () => {
  const { job } = await fixture();
  const status = async () =>
    (await (await workStatus(new Request("http://localhost/api/work-status"))).json()) as { active: boolean; version: string };
  // Nothing queued, nothing building: the page has nothing to wait for and renders no poll.
  expect((await status()).active).toBe(false);

  const [draft] = await database.insert(schema.cvDrafts).values({
    userId: user.id, jobId: job.id, jobTitle: job.title, companyName: "Acme", jobDescription: DESCRIPTION,
    libraryVersion: 1, librarySnapshot: LIBRARY, model: "test", status: "queued", revision: 1,
  }).returning();
  const queued = await status();
  expect(queued.active).toBe(true);

  // Queued to building is what moves the cell, so it has to move the version the poll compares.
  await database.update(schema.cvDrafts).set({ status: "generating" }).where(eq(schema.cvDrafts.id, draft!.id));
  const building = await status();
  expect(building.active).toBe(true);
  expect(building.version).not.toBe(queued.version);

  // The queue row behind the build counts too: an attempt handed back changes what the cell says.
  await database.insert(schema.tasks).values({ type: "generate_cv", payload: { draftId: draft!.id }, dedupeKey: `generate_cv:${draft!.id}`, priority: 2, status: "running" });
  expect((await status()).version).not.toBe(building.version);

  // Published: nothing of this account's is in flight, so the page stops polling itself.
  await database.update(schema.cvDrafts).set({ status: "ready" }).where(eq(schema.cvDrafts.id, draft!.id));
  expect((await status()).active).toBe(false);
  // Another account's build is not this one's business.
  const [other] = await database.insert(schema.users).values({ email: "other-builds@example.com", name: "Other", role: "member", claimedAt: new Date() }).returning();
  await database.insert(schema.cvDrafts).values({
    userId: other!.id, jobId: null, jobTitle: "Elsewhere", companyName: "Elsewhere", jobDescription: DESCRIPTION,
    libraryVersion: 1, librarySnapshot: LIBRARY, model: "test", status: "generating", revision: 1,
  });
  expect((await status()).active).toBe(false);
});

it("sends the retired CV list to the applications table, carrying the role it was opened for", () => {
  const where = (query = "") => {
    const response = cvRedirect(new Request(`https://example.test/cv${query}`));
    expect(response.status).toBe(307);
    // Relative on purpose: see the route's own note about the internal hostname.
    return response.headers.get("location");
  };
  expect(where()).toBe("/applications");
  const id = crypto.randomUUID();
  expect(where(`?job=${id}`)).toBe(`/applications?job=${id}`);
  // A search over a list that no longer exists has no equivalent, and a bad id is not a role.
  expect(where("?job=nonsense&q=analyst")).toBe("/applications");
});
