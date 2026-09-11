import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { sql } from "drizzle-orm";
let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
vi.mock("@/lib/db", () => ({ db: () => database }));
import { listCompanies, companyCount } from "./companies";
import { listPendingSuggestions, suggestionCount } from "./suggestions";
import { saveSettingsAndGate } from "@/lib/settings";
beforeAll(async () => { const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test"); database=client.db; pool=client.pool; await runMigrations(database); });
afterAll(() => pool.end());
beforeEach(() => database.execute(sql`truncate companies, company_suggestions, tasks, settings cascade`));
it("pages and searches a thousand companies without repeating names across page boundaries", async () => {
  for (let offset=0; offset<1000; offset+=100) await database.insert(schema.companies).values(Array.from({ length:100 }, (_,n) => ({ name: `Company ${String(offset+n).padStart(4,"0")}`, domain:`c${offset+n}.test`, homepageUrl:`https://c${offset+n}.test` })));
  const first = await listCompanies(1), next = await listCompanies(2);
  expect(first).toHaveLength(50); expect(next).toHaveLength(50);
  expect(first[0]!.company.name).toBe("Company 0000");
  expect(next[0]!.company.name).toBe("Company 0050");
  expect(await companyCount()).toBe(1000);
  expect(await companyCount("c999.test")).toBe(1);
  expect(await listCompanies(1,"c999.test")).toHaveLength(1);
  expect(await listCompanies(1,"%" )).toHaveLength(0);
});
it("bounds recommendation cards and counts the full filtered set", async () => {
  await database.insert(schema.companySuggestions).values(Array.from({length:101},(_,n)=>({name:`Employer ${String(n).padStart(3,"0")}`,domain:`employer${n}.test`,homepageUrl:`https://employer${n}.test`,rank:n})));
  expect(await listPendingSuggestions()).toHaveLength(50);
  expect(await listPendingSuggestions(3)).toHaveLength(1);
  expect(await suggestionCount()).toBe(101);
  expect(await suggestionCount(false,"Employer 100")).toBe(1);
});
it("queues large filter changes immediately and keeps later changes made during processing", async () => {
  const [company] = await database.insert(schema.companies).values({ name:"Test",domain:"test.test",homepageUrl:"https://test.test" }).returning();
  const [source] = await database.insert(schema.careerSources).values({companyId:company!.id,type:"html",url:"https://test.test/jobs"}).returning();
  await database.insert(schema.jobs).values(Array.from({length:501},(_,n)=>({companyId:company!.id,sourceId:source!.id,externalKey:String(n),title:"Engineer",normalizedTitle:"engineer",url:`https://test.test/jobs/${n}`})));
  await saveSettingsAndGate({hideThreshold:20});
  await saveSettingsAndGate({hideThreshold:30});
  const queued = await database.execute(sql`select count(*)::int as n from tasks where type='reevaluate_gate'`);
  expect(queued.rows[0]!.n).toBe(2);
});

it("keeps every saved and archived CV reachable with stable, clamped pages", async () => {
  const { listCvDraftPage } = await import("./cv");
  await database.execute(sql`truncate cv_drafts cascade`);
  const at = new Date();
  await database.insert(schema.cvDrafts).values(Array.from({ length: 102 }, (_, n) => ({
    jobTitle: `Role ${n}`, companyName: "Example", jobDescription: "Example description", libraryVersion: 1,
    librarySnapshot: { name: "Example", contact: "", profile: "", entries: [] }, model: "test", createdAt: at,
    archivedAt: n === 101 ? at : null,
  })));
  const first = await listCvDraftPage(false, "1"), second = await listCvDraftPage(false, "2"), last = await listCvDraftPage(false, "999");
  expect(first.total).toBe(101); expect(first.rows).toHaveLength(50); expect(second.rows).toHaveLength(50);
  expect(new Set([...first.rows, ...second.rows].map(row => row.id)).size).toBe(100);
  expect(last.page).toBe(3); expect(last.rows).toHaveLength(1);
  expect((await listCvDraftPage(true)).total).toBe(1);
});
