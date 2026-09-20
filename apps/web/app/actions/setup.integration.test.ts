/**
 * Onboarding's two writes: choosing the gate, which is what "filters first" means in practice, and
 * hiding the checklist, which is the only state the checklist has of its own.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import { signInTestUser } from "@/test/auth";
import type { User } from "@christopher/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let user: User;
let other: User;
let otherCookie: string;

vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (session ? { value: session } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

import { saveGate } from "./settings";
import { dismissSetupChecklist } from "./setup";
import { hasChosenGate, setupStatus } from "@/lib/queries/setup";

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "setup-test-secret";
});
afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  await database.execute(sql`truncate companies, tasks, settings, users restart identity cascade`);
  let cookie: string;
  ({ user, cookie } = await signInTestUser(database, process.env.SESSION_SECRET!, "gate@example.com"));
  ({ user: other, cookie: otherCookie } = await signInTestUser(database, process.env.SESSION_SECRET!, "other@example.com", "member"));
  session = cookie;
});

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

const storedGate = async (userId: string) => {
  const [row] = await database.select().from(schema.userSettings)
    .where(and(eq(schema.userSettings.userId, userId), eq(schema.userSettings.key, "gate")));
  return row?.value as Record<string, unknown> | undefined;
};

it("stores the whole gate from one form and marks the filter step done", async () => {
  expect(await hasChosenGate(user.id)).toBe(false);
  const result = await saveGate({ ok: true }, form({
    includeKeywords: "operations, chief of staff",
    excludeKeywords: "intern",
    locationTerms: "London\nRemote",
    includeRemote: "1",
  }));
  expect(result).toEqual({ ok: true });
  expect(await storedGate(user.id)).toMatchObject({
    includeKeywords: ["operations", "chief of staff"],
    excludeKeywords: ["intern"],
    locationTerms: ["London", "Remote"],
    includeRemote: true,
  });
  expect(await hasChosenGate(user.id)).toBe(true);
  expect((await setupStatus(user.id)).gateChosen).toBe(true);
  // Saving the gate queues the re-score the table needs; nobody else's settings were touched.
  expect((await database.select().from(schema.tasks)).map(task => task.type)).toContain("rescore_all");
  expect(await storedGate(other.id)).toBeUndefined();
});

it("refuses a gate with no include keyword, so a saved gate never admits everything", async () => {
  const result = await saveGate({ ok: true }, form({ includeKeywords: "  ", excludeKeywords: "", locationTerms: "London", includeRemote: "1" }));
  expect(result).toEqual({ ok: false, error: expect.stringContaining("at least one keyword") });
  expect(await storedGate(user.id)).toBeUndefined();
  expect(await hasChosenGate(user.id)).toBe(false);
});

it("leaves the remote flag off when its box is unticked", async () => {
  expect((await saveGate({ ok: true }, form({ includeKeywords: "operations", locationTerms: "London" }))).ok).toBe(true);
  expect(await storedGate(user.id)).toMatchObject({ locationTerms: ["London"], includeRemote: false });
});

it("hides the checklist for the account that asked, and for nobody else", async () => {
  await dismissSetupChecklist();
  const dismissedAt = (await setupStatus(user.id)).dismissedAt;
  expect(typeof dismissedAt).toBe("string");
  expect(Number.isNaN(Date.parse(dismissedAt!))).toBe(false);
  expect((await setupStatus(other.id)).dismissedAt).toBeNull();

  session = otherCookie;
  await dismissSetupChecklist();
  expect((await setupStatus(other.id)).dismissedAt).not.toBeNull();

  session = undefined;
  await expect(dismissSetupChecklist()).rejects.toThrow("Unauthorised");
});
