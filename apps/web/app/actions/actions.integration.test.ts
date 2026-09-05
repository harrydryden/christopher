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
import { decide, saveDecisionTags } from "./decisions";
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
  await database.execute(sql`truncate companies, decisions, tasks, settings, preference_profiles, tag_vocabulary restart identity cascade`);
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
    expect(updated!.inTable).toBe(false);
    expect(updated!.keywordTerms).toEqual([]);
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
