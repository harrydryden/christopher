import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, subscribeToCompany, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@christopher/db/schema";
let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
import { listCompanies, companyCount } from "./companies";
import { listPendingSuggestions, suggestionCount } from "./suggestions";
import { saveSettingsAndGate } from "@/lib/settings";
beforeAll(async () => { const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test"); database=client.db; pool=client.pool; await runMigrations(database); user = await ensureTestUser(database); });
afterAll(() => pool.end());
beforeEach(() => database.execute(sql`truncate companies, company_suggestions, tasks, settings, user_settings cascade`));
it("pages and searches a thousand followed companies without repeating names across page boundaries", async () => {
  for (let offset=0; offset<1000; offset+=100) {
    const rows = await database.insert(schema.companies).values(Array.from({ length:100 }, (_,n) => ({ name: `Company ${String(offset+n).padStart(4,"0")}`, domain:`c${offset+n}.test`, homepageUrl:`https://c${offset+n}.test` }))).returning({ id: schema.companies.id });
    await database.insert(schema.companySubscriptions).values(rows.map(row => ({ userId: user.id, companyId: row.id })));
  }
  // A company someone else follows is not in this account's list.
  await database.insert(schema.companies).values({ name: "Company 9999", domain: "c9999.test", homepageUrl: "https://c9999.test" });
  const first = await listCompanies(user.id, 1), next = await listCompanies(user.id, 2);
  expect(first).toHaveLength(50); expect(next).toHaveLength(50);
  expect(first[0]!.company.name).toBe("Company 0000");
  expect(next[0]!.company.name).toBe("Company 0050");
  expect(await companyCount(user.id)).toBe(1000);
  expect(await companyCount(user.id, "c999.test")).toBe(1);
  expect(await companyCount(user.id, "c9999.test")).toBe(0);
  expect(await listCompanies(user.id, 1, "c999.test")).toHaveLength(1);
  expect(await listCompanies(user.id, 1, "%" )).toHaveLength(0);
});
it("bounds recommendation cards and counts the full filtered set for one account", async () => {
  const other = await ensureTestUser(database, "other@example.com", "member");
  await database.insert(schema.companySuggestions).values(Array.from({length:101},(_,n)=>({userId: user.id, name:`Employer ${String(n).padStart(3,"0")}`,domain:`employer${n}.test`,homepageUrl:`https://employer${n}.test`,rank:n})));
  await database.insert(schema.companySuggestions).values({ userId: other.id, name: "Employer 000", domain: "employer0.test", homepageUrl: "https://employer0.test", rank: 0 });
  expect(await listPendingSuggestions(user.id)).toHaveLength(50);
  expect(await listPendingSuggestions(user.id, 3)).toHaveLength(1);
  expect(await suggestionCount(user.id)).toBe(101);
  expect(await suggestionCount(user.id, false, "Employer 100")).toBe(1);
  expect(await suggestionCount(other.id)).toBe(1);
});
it("queues large filter changes immediately and keeps later changes made during processing", async () => {
  const [company] = await database.insert(schema.companies).values({ name:"Test",domain:"test.test",homepageUrl:"https://test.test" }).returning();
  await subscribeToCompany(database, user.id, company!.id);
  const [source] = await database.insert(schema.careerSources).values({companyId:company!.id,type:"html",url:"https://test.test/jobs"}).returning();
  await database.insert(schema.jobs).values(Array.from({length:501},(_,n)=>({companyId:company!.id,sourceId:source!.id,externalKey:String(n),title:"Engineer",normalizedTitle:"engineer",url:`https://test.test/jobs/${n}`})));
  await saveSettingsAndGate(user.id, {hideThreshold:20});
  await saveSettingsAndGate(user.id, {hideThreshold:30});
  const queued = await database.execute(sql`select count(*)::int as n, min(payload->>'userId') as user_id from tasks where type='reevaluate_gate'`);
  expect(queued.rows[0]!.n).toBe(2);
  expect(queued.rows[0]!.user_id).toBe(user.id);
});

it("keeps every saved and archived CV reachable with stable, clamped pages", async () => {
  const { listCvDraftPage } = await import("./cv");
  await database.execute(sql`truncate cv_drafts cascade`);
  const at = new Date();
  await database.insert(schema.cvDrafts).values(Array.from({ length: 102 }, (_, n) => ({
    userId: user.id, jobTitle: `Role ${n}`, companyName: "Example", jobDescription: "Example description", libraryVersion: 1,
    librarySnapshot: { name: "Example", contact: "", profile: "", entries: [] }, model: "test", createdAt: at,
    archivedAt: n === 101 ? at : null,
  })));
  const first = await listCvDraftPage(user.id, false, "1"), second = await listCvDraftPage(user.id, false, "2"), last = await listCvDraftPage(user.id, false, "999");
  expect(first.total).toBe(101); expect(first.rows).toHaveLength(50); expect(second.rows).toHaveLength(50);
  expect(new Set([...first.rows, ...second.rows].map(row => row.id)).size).toBe(100);
  expect(last.page).toBe(3); expect(last.rows).toHaveLength(1);
  expect((await listCvDraftPage(user.id, true)).total).toBe(1);
});
