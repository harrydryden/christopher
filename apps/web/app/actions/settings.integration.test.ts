/**
 * The Settings actions, against the database: what a member may set for themselves, and what a
 * save sets in motion.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, subscribeToCompany, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@ava/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import { MAX_MEMBER_AI_BUDGET_USD } from "@ava/core";
import { signInTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let admin: { user: User; cookie: string };
let member: { user: User; cookie: string };
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (session ? { value: session } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

import { saveAiBudget, saveGate, saveTableSettings } from "./settings";
import { acceptFilterSuggestionWithReport } from "./learning";
import { setAccountAiBudget } from "./account";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "integration-test-secret";
}, 120_000);
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate companies, tasks, user_settings, users restart identity cascade`);
  admin = await signInTestUser(database, process.env.SESSION_SECRET!, "settings-admin@example.com", "admin");
  member = await signInTestUser(database, process.env.SESSION_SECRET!, "settings-member@example.com", "member");
  session = member.cookie;
});

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const budgetOf = async (userId: string) => (await database.select().from(schema.userSettings)
  .where(and(eq(schema.userSettings.userId, userId), eq(schema.userSettings.key, "aiBudgetUsd"))))[0]?.value;

it("lets a member set their own AI budget up to the member ceiling, and an administrator any figure", async () => {
  expect(MAX_MEMBER_AI_BUDGET_USD).toBe(100);
  expect(await saveAiBudget({ ok: true }, form({ aiBudgetUsd: "100" }))).toEqual({ ok: true });
  expect(await saveAiBudget({ ok: true }, form({ aiBudgetUsd: "101" }))).toEqual({ ok: false, error: "You can set your monthly AI budget up to $100. Ask an administrator for more." });
  expect(await saveAiBudget({ ok: true }, form({ aiBudgetUsd: "10000" }))).toMatchObject({ ok: false });
  expect(await budgetOf(member.user.id)).toBe(100);

  session = admin.cookie;
  expect(await saveAiBudget({ ok: true }, form({ aiBudgetUsd: "5000" }))).toEqual({ ok: true });
  expect(await budgetOf(admin.user.id)).toBe(5000);
});

it("lets a member lower a budget an administrator granted, but never raise it past the grant", async () => {
  session = admin.cookie;
  await setAccountAiBudget(member.user.id, form({ aiBudgetUsd: "500" }));
  session = member.cookie;
  expect(await saveAiBudget({ ok: true }, form({ aiBudgetUsd: "400" }))).toEqual({ ok: true });
  expect(await budgetOf(member.user.id)).toBe(400);
  // Lowered is lowered: the grant is what is stored, so the way back up is the administrator's.
  expect(await saveAiBudget({ ok: true }, form({ aiBudgetUsd: "500" }))).toEqual({ ok: false, error: "You can set your monthly AI budget up to $400, the budget an administrator gave you. Ask an administrator for more." });
  expect(await budgetOf(member.user.id)).toBe(400);
});

/** A followed company with `count` stored postings, so a gate save runs inline or queues its pass. */
async function followedPostings(userId: string, count: number) {
  const [company] = await database.insert(schema.companies).values({ name: "Big", domain: "big.example", homepageUrl: "https://big.example" }).returning();
  await subscribeToCompany(database, userId, company!.id);
  const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://big.example/jobs" }).returning();
  await database.insert(schema.jobs).values(Array.from({ length: count }, (_, n) => ({
    companyId: company!.id, sourceId: source!.id, externalKey: String(n), title: "Chief of Staff", normalizedTitle: "chief of staff", url: `https://big.example/jobs/${n}`,
  })));
}
const taskTypes = async () => (await database.select({ type: schema.tasks.type }).from(schema.tasks)).map(row => row.type).sort();

it("saves a display setting without re-evaluating or re-scoring anything", async () => {
  await followedPostings(member.user.id, 3);
  expect(await saveTableSettings({ ok: true }, form({ showClosedDays: "14" }))).toEqual({ ok: true });
  expect(await taskTypes()).toEqual([]);
  expect((await database.select().from(schema.userSettings).where(eq(schema.userSettings.key, "showClosedDays")))[0]!.value).toBe(14);
});

it("re-evaluates and re-scores only when a save changes the gate", async () => {
  await followedPostings(member.user.id, 3);
  expect(await saveGate({ ok: true }, form({ includeKeywords: "chief of staff", locationTerms: "" }))).toEqual({ ok: true });
  expect(await database.select().from(schema.userJobs)).toHaveLength(3);
  expect(await taskTypes()).toContain("rescore_all");
  await database.execute(sql`truncate tasks`);
  expect(await saveGate({ ok: true }, form({ includeKeywords: "chief of staff", locationTerms: "" }))).toEqual({ ok: true });
  expect(await taskTypes()).toEqual([]);
});

it("queues one re-evaluation when accepting a suggestion widens a large account's gate", async () => {
  await followedPostings(member.user.id, 501);
  const [suggestion] = await database.insert(schema.filterSuggestions)
    .values({ userId: member.user.id, type: "keyword_include", value: { term: "chief of staff" }, rationale: "" }).returning();
  expect(await acceptFilterSuggestionWithReport(suggestion!.id)).toMatchObject({ ok: true });
  expect((await taskTypes()).filter(type => type === "reevaluate_gate")).toHaveLength(1);
});

it("lifts a large account's waiting background pass to the person's gate save instead of queuing a second", async () => {
  await followedPostings(member.user.id, 501);
  await database.insert(schema.tasks).values({ type: "reevaluate_gate", payload: { userId: member.user.id, reason: "boot" }, dedupeKey: `reevaluate_gate:${member.user.id}`, priority: 6 });
  expect(await saveGate({ ok: true }, form({ includeKeywords: "chief of staff", locationTerms: "" }))).toEqual({ ok: true });
  const passes = await database.select().from(schema.tasks).where(eq(schema.tasks.type, "reevaluate_gate"));
  expect(passes.map(pass => pass.priority)).toEqual([1]);
});
