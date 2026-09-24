/**
 * The catalogue is shared and a company is scanned once a day however many accounts follow it.
 * These are the interface's follow paths: adding a URL that is already in the catalogue must
 * subscribe the account and admit what the last scan stored, and must not queue a second scan.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";
import { signInTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let first: User;
let second: User;
let firstCookie: string;
let secondCookie: string;

vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (session ? { value: session } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

import { addCompanies, archiveCompany, importPosting, pasteDiscoveryUrl, refreshCompanyLogo, rescanCompany, resumeCompany, saveCompanyNotes, suggestCompanyName, unfollowCompany } from "./companies";
import { companyApplicationCount, companyScanTiming, listCompanies } from "@/lib/queries/companies";
import { scanTimingLine } from "@/app/(app)/companies/scan-line";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "companies-test-secret";
});
afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  await database.execute(sql`truncate companies, tasks, settings, users restart identity cascade`);
  ({ user: first, cookie: firstCookie } = await signInTestUser(database, process.env.SESSION_SECRET!, "one@example.com"));
  ({ user: second, cookie: secondCookie } = await signInTestUser(database, process.env.SESSION_SECRET!, "two@example.com", "member"));
  // Filters first: `addCompanies` refuses an account that has never chosen its gate, so both
  // accounts start with one saved, exactly as a person reaches the form through setup.
  await chooseGate(first.id);
  await chooseGate(second.id);
  session = firstCookie;
});

/** The gate this account chose. Its presence, not its contents, is what unlocks following a company. */
const chooseGate = (userId: string) =>
  database.insert(schema.userSettings).values({ userId, key: "gate", value: { includeKeywords: ["operations"], excludeKeywords: [], matchFields: ["title"], locationTerms: [], includeRemote: true } })
    .onConflictDoNothing();

const urls = (value: string) => { const form = new FormData(); form.set("urls", value); return form; };
const tasksOfType = (type: "scan_company" | "discover" | "reevaluate_gate" | "import_posting") =>
  database.select().from(schema.tasks).where(eq(schema.tasks.type, type));
const urlForm = (value: string) => { const form = new FormData(); form.set("url", value); return form; };
const nameForm = (value: string) => { const form = new FormData(); form.set("name", value); return form; };

/** The company one account already added, with a source and a posting a scan stored. */
async function scannedCompany() {
  const [company] = await database.select().from(schema.companies);
  const [source] = await database.insert(schema.careerSources)
    .values({ companyId: company!.id, type: "html", url: "https://acme.example/jobs", status: "active" }).returning();
  const [job] = await database.insert(schema.jobs).values({
    companyId: company!.id, sourceId: source!.id, externalKey: "id:1", title: "Operations Manager",
    normalizedTitle: "operations manager", url: "https://acme.example/jobs/1", location: "London",
  }).returning();
  return { company: company!, job: job! };
}

it("follows a company already in the catalogue instead of adding or scanning a second one", async () => {
  await expect(addCompanies(urls("https://acme.example"))).rejects.toThrow("redirect:/companies?added=1");
  expect(await database.select().from(schema.companies)).toHaveLength(1);
  // Adding a company discovers its careers source; it does not scan directly.
  expect(await tasksOfType("discover")).toHaveLength(1);
  expect(await tasksOfType("scan_company")).toHaveLength(0);
  const { company, job } = await scannedCompany();

  // A second account adds the same URL. One catalogue entry, two subscriptions, no second scan.
  session = secondCookie;
  await expect(addCompanies(urls("https://www.acme.example/careers"))).rejects.toThrow("redirect:/companies?added=0&followed=1");
  expect(await database.select().from(schema.companies)).toHaveLength(1);
  expect(await tasksOfType("scan_company")).toHaveLength(0);
  expect(await tasksOfType("discover")).toHaveLength(1);
  const subscriptions = await database.select().from(schema.companySubscriptions);
  expect(subscriptions.map(s => s.userId).sort()).toEqual([first.id, second.id].sort());

  // The new follower's table is filled from what the last scan already stored, per its own gate.
  const views = await database.select().from(schema.userJobs);
  expect(views.map(v => [v.userId, v.jobId, v.inTable, v.seeded])).toEqual([[second.id, job.id, true, true]]);

  // Re-adding it again changes nothing at all.
  await expect(addCompanies(urls("https://acme.example"))).rejects.toThrow("redirect:/companies?added=0");
  expect(await tasksOfType("scan_company")).toHaveLength(0);
  expect(await database.select().from(schema.userJobs)).toHaveLength(1);

  // Either follower can ask for a rescan, and both asking queues one shared scan, not two.
  await rescanCompany(company.id);
  session = firstCookie;
  await rescanCompany(company.id);
  const scans = await tasksOfType("scan_company");
  expect(scans).toHaveLength(1);
  expect(scans[0]!.payload).toMatchObject({ companyId: company.id, trigger: "manual" });
});

it("refuses to follow a company until this account has chosen its keywords and locations", async () => {
  // Existing accounts that never saved a gate are in exactly this position: one save frees them.
  await database.delete(schema.userSettings).where(eq(schema.userSettings.userId, first.id));
  await expect(addCompanies(urls("https://acme.example"))).rejects.toThrow("Choose your keywords and locations first, so the first scan runs against your filters.");
  expect(await database.select().from(schema.companies)).toHaveLength(0);
  expect(await database.select().from(schema.companySubscriptions)).toHaveLength(0);
  expect(await tasksOfType("discover")).toHaveLength(0);

  // Adding a role by its URL is deliberately not held back: it bypasses the gate by design.
  await chooseGate(first.id);
  await expect(addCompanies(urls("https://acme.example"))).rejects.toThrow("redirect:/companies?added=1");
  const [company] = await database.select().from(schema.companies);
  await database.delete(schema.userSettings).where(eq(schema.userSettings.userId, first.id));
  await importPosting(company!.id, urlForm("https://acme.example/jobs/1"));
  expect(await tasksOfType("import_posting")).toHaveLength(1);
});

it("leaves the shared company and the other follower alone when one account stops following", async () => {
  await expect(addCompanies(urls("https://acme.example"))).rejects.toThrow("redirect:/companies?added=1");
  const { company, job } = await scannedCompany();
  session = secondCookie;
  await expect(addCompanies(urls("https://acme.example"))).rejects.toThrow("redirect:/companies?added=0&followed=1");
  expect(await database.select().from(schema.userJobs)).toHaveLength(1);

  await expect(unfollowCompany(company.id)).rejects.toThrow("redirect:/companies");
  // The catalogue entry, its source and every observed posting stay; only this account's view goes.
  expect(await database.select().from(schema.companies)).toHaveLength(1);
  expect(await database.select().from(schema.jobs)).toHaveLength(1);
  expect(await database.select().from(schema.userJobs)).toHaveLength(0);
  expect((await database.select().from(schema.companySubscriptions)).map(s => s.userId)).toEqual([first.id]);
  // One active follower is still enough to keep the shared company scanned.
  expect((await database.select().from(schema.companies))[0]!.status).toBe("active");
  expect(job.companyId).toBe(company.id);
});

/** The account that added the company follows it; `second` does not until it says so. */
async function followedCompany() {
  await expect(addCompanies(urls("https://acme.example"))).rejects.toThrow("redirect:/companies?added=1");
  const [company] = await database.select().from(schema.companies);
  return company!;
}

it("queues one import per posting, however the URL was decorated, and only for a follower", async () => {
  const company = await followedCompany();

  await importPosting(company.id, urlForm("https://job-boards.greenhouse.io/acme/jobs/1234567?utm_source=newsletter&gh_src=abc#apply"));
  const queued = await tasksOfType("import_posting");
  expect(queued).toHaveLength(1);
  // Acme has no Greenhouse board of its own, so the posting is flagged to stay this account's.
  expect(queued[0]!.payload).toEqual({ userId: first.id, companyId: company.id, url: "https://job-boards.greenhouse.io/acme/jobs/1234567", foreignHost: true });

  // The same posting pasted again, from the board this time: one task, not two.
  await importPosting(company.id, urlForm("  https://job-boards.greenhouse.io/acme/jobs/1234567/  "));
  expect(await tasksOfType("import_posting")).toHaveLength(1);

  // A different posting is its own task.
  await importPosting(company.id, urlForm("https://job-boards.greenhouse.io/acme/jobs/7654321"));
  expect(await tasksOfType("import_posting")).toHaveLength(2);

  // An account that does not follow the company cannot put anything in the shared catalogue.
  session = secondCookie;
  await expect(importPosting(company.id, urlForm("https://job-boards.greenhouse.io/acme/jobs/999"))).rejects.toThrow("You do not follow this company.");
  expect(await tasksOfType("import_posting")).toHaveLength(2);
});

it("takes a member's name suggestion as a proposal and an administrator's as the rename", async () => {
  const company = await followedCompany();
  session = secondCookie;
  await expect(addCompanies(urls("https://acme.example"))).rejects.toThrow("redirect:/companies?added=0&followed=1");

  // A member proposes; the shared name is untouched until an administrator says so.
  expect(await suggestCompanyName(company.id, { ok: true }, nameForm("  Acme Robotics  "))).toEqual({ ok: true, message: "An administrator will review your suggestion." });
  const pending = await database.select().from(schema.companyNameSuggestions);
  expect(pending.map(row => [row.userId, row.name, row.status])).toEqual([[second.id, "Acme Robotics", "pending"]]);
  expect((await database.select().from(schema.companies))[0]!.name).toBe(company.name);

  // Proposing again corrects that one row rather than queuing a second.
  await suggestCompanyName(company.id, { ok: true }, nameForm("Acme Robotics Ltd"));
  const corrected = await database.select().from(schema.companyNameSuggestions);
  expect(corrected).toHaveLength(1);
  expect(corrected[0]!.name).toBe("Acme Robotics Ltd");

  // An administrator proposing a name is renaming it: applied on the spot, and recorded as theirs.
  session = firstCookie;
  const result = await suggestCompanyName(company.id, { ok: true }, nameForm("Acme Robotics plc"));
  expect(result).toEqual({ ok: true, message: "Renamed to «Acme Robotics plc»." });
  expect((await database.select().from(schema.companies))[0]!.name).toBe("Acme Robotics plc");
  const applied = (await database.select().from(schema.companyNameSuggestions)).find(row => row.userId === first.id)!;
  expect([applied.status, applied.resolvedBy]).toEqual(["applied", first.id]);
  // The member's proposal is untouched: an administrator resolves it in the catalogue.
  expect((await database.select().from(schema.companyNameSuggestions)).find(row => row.userId === second.id)!.status).toBe("pending");

  expect(await suggestCompanyName(company.id, { ok: true }, nameForm("   "))).toEqual({ ok: false, error: "Enter the company's name." });
});

it("stores the notepad's text, clears it to null when empty, and refuses an unreasonable one", async () => {
  const company = await followedCompany();
  const notes = async () => (await database.select().from(schema.companySubscriptions))[0]!.notes;

  expect(await saveCompanyNotes(company.id, "Spoke to their recruiter.\n\n- **next** wave ~September")).toEqual({ ok: true });
  expect(await notes()).toBe("Spoke to their recruiter.\n\n- **next** wave ~September");

  expect(await saveCompanyNotes(company.id, "   ")).toEqual({ ok: true });
  expect(await notes()).toBeNull();

  expect(await saveCompanyNotes(company.id, "x".repeat(20_001)))
    .toEqual({ ok: false, error: "These notes are too long. Keep them under 20,000 characters." });
  expect(await notes()).toBeNull();

  session = secondCookie;
  expect(await saveCompanyNotes(company.id, "not mine")).toEqual({ ok: false, error: "You do not follow this company." });
});

it("queues a logo capture for one company without disturbing its scan", async () => {
  const company = await followedCompany();
  await refreshCompanyLogo(company.id);
  const discovers = await tasksOfType("discover");
  // The company was added with a discovery task; the logo capture is a second, separately keyed one.
  expect(discovers.map(task => task.dedupeKey).sort()).toEqual([`company_logo:${company.id}:${company.homepageUrl}`, `discover:${company.id}`]);
  expect(discovers.find(task => task.dedupeKey?.startsWith("company_logo"))!.payload)
    .toEqual({ companyId: company.id, logoOnly: true, homepageUrl: company.homepageUrl });

  // Asking twice while it is still queued queues nothing more.
  await refreshCompanyLogo(company.id);
  expect(await tasksOfType("discover")).toHaveLength(2);
  expect(await tasksOfType("scan_company")).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// What the company page reads: the scan schedule line, the per-company
// applications link, and the counts the companies list shows per row.
// ---------------------------------------------------------------------------

/** One posting of the shared company, with this account's view of it. */
async function posting(companyId: string, sourceId: string, key: string, userId = first.id, jobStatus: "open" | "closed" = "open") {
  const [job] = await database.insert(schema.jobs).values({
    companyId, sourceId, externalKey: key, title: `Role ${key}`, normalizedTitle: `role ${key}`,
    url: `https://acme.example/jobs/${key}`, status: jobStatus,
  }).returning();
  await database.insert(schema.userJobs).values({ userId, jobId: job!.id, inTable: true, keywordMatched: true });
  return job!;
}

async function decideOn(jobId: string, decision: "apply" | "skip", userId = first.id) {
  await database.insert(schema.decisions).values({ userId, jobId, decision, reason: "because", jobTitle: "Role", companyName: "Acme" });
}

it("counts the roles at one company this account is pursuing, by the Applications page's own rule", async () => {
  const company = await followedCompany();
  const [source] = await database.insert(schema.careerSources)
    .values({ companyId: company.id, type: "greenhouse", url: "https://boards.greenhouse.io/acme", status: "active" }).returning();

  const matched = await posting(company.id, source!.id, "1");
  const shortlisted = await posting(company.id, source!.id, "2");
  const passedOn = await posting(company.id, source!.id, "3");
  const withdrawn = await posting(company.id, source!.id, "4");
  const dismissedWithCv = await posting(company.id, source!.id, "5");
  await decideOn(shortlisted.id, "apply");
  await decideOn(passedOn.id, "skip");
  await decideOn(withdrawn.id, "skip");
  await decideOn(dismissedWithCv.id, "skip");
  await database.insert(schema.applications).values({
    userId: first.id, jobId: withdrawn.id, jobTitle: "Role 4", companyName: "Acme", appliedOn: "2026-09-01",
    status: "withdrawn", history: [],
  });
  await database.insert(schema.cvDrafts).values({
    userId: first.id, jobId: dismissedWithCv.id, jobTitle: "Role 5", companyName: "Acme", jobDescription: "text",
    libraryVersion: 1, librarySnapshot: { name: "", contact: "", profile: "", employment: [], entries: [] }, model: "test",
  });

  // Matched is not an application; a role merely passed on is not either. A withdrawal and a
  // dismissed role that carries a CV were both pursued, so they count.
  expect(await companyApplicationCount(first.id, company.id)).toBe(3);
  expect(matched.id).toBeTruthy();

  // Another account's pursuit of the same shared postings is not this account's count.
  await database.insert(schema.userJobs).values({ userId: second.id, jobId: shortlisted.id, inTable: true, keywordMatched: true });
  await decideOn(shortlisted.id, "apply", second.id);
  expect(await companyApplicationCount(first.id, company.id)).toBe(3);
  expect(await companyApplicationCount(second.id, company.id)).toBe(1);
});

it("reads when a company was last scanned and whether the last rescan was served from that scan", async () => {
  const company = await followedCompany();
  const [source] = await database.insert(schema.careerSources)
    .values({ companyId: company.id, type: "html", url: "https://acme.example/jobs", status: "active" }).returning();

  expect(await companyScanTiming(company.id)).toEqual({ lastGoodScanAt: null, rescanSkippedAt: null });

  // A failed scan is not one a rescan could be served from; the newest ok or partial one is.
  const scanned = new Date(Date.now() - 12 * 60_000);
  await database.insert(schema.scans).values([
    { sourceId: source!.id, status: "ok", startedAt: scanned },
    { sourceId: source!.id, status: "failed", startedAt: new Date(Date.now() - 60_000) },
  ]);
  expect((await companyScanTiming(company.id)).lastGoodScanAt?.getTime()).toBe(scanned.getTime());
  expect((await companyScanTiming(company.id)).rescanSkippedAt).toBeNull();

  // The worker finishes a manual rescan inside the reuse window by saying it did nothing.
  const skippedAt = new Date(Date.now() - 30_000);
  await database.insert(schema.tasks).values({
    type: "scan_company", payload: { companyId: company.id, trigger: "manual" }, status: "done",
    result: { skipped: "scanned recently", sources: 1 }, finishedAt: skippedAt,
  });
  expect((await companyScanTiming(company.id)).rescanSkippedAt?.getTime()).toBe(skippedAt.getTime());
  expect(scanTimingLine(await companyScanTiming(company.id), "06:00", "Europe/London"))
    .toBe("Rescan skipped: scanned 12m ago; a scan made in the last half hour is reused.");

  // A later scan that really ran is the newest finished task, so nothing claims a skip any more.
  await database.insert(schema.tasks).values({
    type: "scan_company", payload: { companyId: company.id, trigger: "manual" }, status: "done",
    result: { sources: 1, new: 2, closed: 0 }, finishedAt: new Date(),
  });
  expect((await companyScanTiming(company.id)).rescanSkippedAt).toBeNull();
  expect(scanTimingLine(await companyScanTiming(company.id), "06:00", "Europe/London"))
    .toBe("Scanned 12m ago · next scheduled scan at 06:00 Europe/London");
});

it("gives each companies-list row its open, review and shortlisted counts and the source a scan reads", async () => {
  const company = await followedCompany();
  const [failing] = await database.insert(schema.careerSources)
    .values({ companyId: company.id, type: "html", url: "https://acme.example/jobs", status: "failing" }).returning();
  const [row] = await listCompanies(first.id);
  expect([row!.sourceType, row!.openRoles, row!.reviewRoles, row!.shortlistedRoles]).toEqual(["html", 0, 0, 0]);

  const open = await posting(company.id, failing!.id, "1");
  const closed = await posting(company.id, failing!.id, "2", first.id, "closed");
  const shortlisted = await posting(company.id, failing!.id, "3");
  await decideOn(shortlisted.id, "apply");
  const [counted] = await listCompanies(first.id);
  // Open counts what is still live in this account's table; Review is what it has not decided on.
  expect([counted!.openRoles, counted!.reviewRoles, counted!.shortlistedRoles]).toEqual([2, 2, 1]);
  expect([open.status, closed.status]).toEqual(["open", "closed"]);

  // An active source names the row even when a failing one was created first.
  await database.insert(schema.careerSources)
    .values({ companyId: company.id, type: "greenhouse", url: "https://boards.greenhouse.io/acme", status: "active" });
  expect((await listCompanies(first.id))[0]!.sourceType).toBe("greenhouse");
});

/** `count` companies the account already follows, straight into the tables. */
async function alreadyFollowing(userId: string, count: number, prefix = "held") {
  const rows = await database.insert(schema.companies).values(Array.from({ length: count }, (_, n) => ({
    name: `${prefix} ${n}`, domain: `${prefix}${n}.example`, homepageUrl: `https://${prefix}${n}.example`,
  }))).returning({ id: schema.companies.id });
  await database.insert(schema.companySubscriptions).values(rows.map(row => ({ userId, companyId: row.id })));
  return rows.map(row => row.id);
}

it("refuses a submission of more than 25 companies, in a sentence on the page, and writes nothing", async () => {
  const lines = Array.from({ length: 26 }, (_, n) => `https://many${n}.example`).join("\n");
  await expect(addCompanies(urls(lines))).rejects.toThrow(`redirect:/companies?error=${encodeURIComponent("Add at most 25 companies at a time. This list has 26.").replace(/%20/g, "+")}`);
  expect(await database.select().from(schema.companies)).toHaveLength(0);
  expect(await database.select().from(schema.tasks)).toHaveLength(0);
});

it("holds a member to 200 followed companies, counted under one lock, and leaves administrators unlimited", async () => {
  session = secondCookie;
  await alreadyFollowing(second.id, 198);
  // Two at once from one account: one fills the allowance, the other is refused whole.
  const outcomes = await Promise.allSettled([
    addCompanies(urls("https://new-a.example\nhttps://new-b.example")),
    addCompanies(urls("https://new-c.example\nhttps://new-d.example")),
  ]);
  const messages = outcomes.map(outcome => outcome.status === "rejected" ? String((outcome.reason as Error).message) : "resolved");
  expect(messages.filter(message => message.startsWith("redirect:/companies?added=2"))).toHaveLength(1);
  // The second is counted after the first commits, so it sees the allowance already full.
  expect(messages.filter(message => message.includes("error=") && message.includes("up+to+200+companies%2C+and+you+follow+200"))).toHaveLength(1);
  const following = await database.select().from(schema.companySubscriptions).where(eq(schema.companySubscriptions.userId, second.id));
  expect(following).toHaveLength(200);
  expect(await database.select().from(schema.companies)).toHaveLength(200);

  // Following one already followed adds nothing to the count, so it is not refused.
  await expect(addCompanies(urls("https://held1.example"))).rejects.toThrow("redirect:/companies?added=0");
  // An archived follow is outside the allowance, and bringing it back counts like a new one.
  const [held] = await database.select().from(schema.companies).where(eq(schema.companies.domain, "held0.example"));
  await archiveCompany(held!.id);
  await expect(addCompanies(urls("https://new-e.example"))).rejects.toThrow("redirect:/companies?added=1");
  await expect(resumeCompany(held!.id)).rejects.toThrow("redirect:/companies?error=");
  const [archived] = await database.select().from(schema.companySubscriptions)
    .where(eq(schema.companySubscriptions.companyId, held!.id));
  expect(archived!.status).toBe("archived");

  // The administrator is not limited.
  session = firstCookie;
  await alreadyFollowing(first.id, 200, "admin");
  await expect(addCompanies(urls("https://admin-more.example"))).rejects.toThrow("redirect:/companies?added=1");
});

it("records who added a company, admits five followed companies inline and queues the rest", async () => {
  // Seven companies already in the catalogue, each with a stored role the gate admits.
  const ids = await alreadyFollowing(second.id, 7, "known");
  for (const [n, companyId] of ids.entries()) {
    const [source] = await database.insert(schema.careerSources).values({ companyId, type: "html", url: `https://known${n}.example/jobs` }).returning();
    await database.insert(schema.jobs).values({ companyId, sourceId: source!.id, externalKey: "1", title: "Operations Lead", normalizedTitle: "operations lead", url: `https://known${n}.example/jobs/1` });
  }
  await expect(addCompanies(urls(Array.from({ length: 7 }, (_, n) => `https://known${n}.example`).join("\n")))).rejects.toThrow("redirect:/companies?added=0&followed=7");
  expect(await database.select().from(schema.userJobs).where(eq(schema.userJobs.userId, first.id))).toHaveLength(5);
  const queued = await tasksOfType("reevaluate_gate");
  expect(queued.map(task => task.dedupeKey).sort()).toEqual(ids.slice(5).map(id => `reevaluate_gate:${first.id}:${id}`).sort());

  await expect(addCompanies(urls("https://brand-new.example"))).rejects.toThrow("redirect:/companies?added=1");
  const [created] = await database.select().from(schema.companies).where(eq(schema.companies.domain, "brand-new.example"));
  expect(created!.addedBy).toBe(first.id);
});

it("keeps one pasted discovery in hand per company", async () => {
  const company = await followedCompany();
  await pasteDiscoveryUrl(company.id, urlForm("https://acme.example/careers"));
  await expect(pasteDiscoveryUrl(company.id, urlForm("https://acme.example/jobs"))).rejects.toThrow("still being checked");
  expect((await tasksOfType("discover")).filter(task => (task.payload as { reason?: string }).reason === "pasted")).toHaveLength(1);
  await database.update(schema.tasks).set({ status: "done" }).where(eq(schema.tasks.type, "discover"));
  await pasteDiscoveryUrl(company.id, urlForm("https://acme.example/jobs"));
  expect((await tasksOfType("discover")).filter(task => task.status === "queued")).toHaveLength(1);
});

it("flags a pasted posting that is not on the company's own hosts, so the worker keeps it private", async () => {
  const company = await followedCompany();
  await database.insert(schema.careerSources).values({ companyId: company.id, type: "greenhouse", url: "https://job-boards.greenhouse.io/acme", atsSlug: "acme" });
  await importPosting(company.id, urlForm("https://careers.acme.example/jobs/ops-lead"));
  await importPosting(company.id, urlForm("https://job-boards.greenhouse.io/acme/jobs/1"));
  await importPosting(company.id, urlForm("https://job-boards.greenhouse.io/rival/jobs/1"));
  await importPosting(company.id, urlForm("https://attacker.example/acme-senior-operations"));
  const flags = Object.fromEntries((await tasksOfType("import_posting")).map(task => [(task.payload as { url: string }).url, (task.payload as { foreignHost: boolean }).foreignHost]));
  expect(flags).toEqual({
    "https://careers.acme.example/jobs/ops-lead": false,
    "https://job-boards.greenhouse.io/acme/jobs/1": false,
    "https://job-boards.greenhouse.io/rival/jobs/1": true,
    "https://attacker.example/acme-senior-operations": true,
  });
});

it("refuses addresses the worker will never fetch, in a sentence, before anything is queued", async () => {
  await expect(addCompanies(urls("http://10.0.0.1\nhttp://printer.local\nhttps://acme.example"))).rejects.toThrow(
    `redirect:/companies?${new URLSearchParams({ added: "1", skipped: "10.0.0.1 is a private or local network address, printer.local is a local network name" }).toString()}`,
  );
  expect((await database.select().from(schema.companies)).map(row => row.domain)).toEqual(["acme.example"]);
  const [company] = await database.select().from(schema.companies);
  await expect(importPosting(company!.id, urlForm("http://192.168.1.10/jobs/1"))).rejects.toThrow("192.168.1.10 is a private or local network address.");
  await expect(pasteDiscoveryUrl(company!.id, urlForm("http://metadata.google.internal/careers"))).rejects.toThrow("metadata.google.internal is a local network name.");
  expect(await tasksOfType("import_posting")).toHaveLength(0);
  expect((await tasksOfType("discover")).filter(task => (task.payload as { reason?: string }).reason === "pasted")).toHaveLength(0);
});
