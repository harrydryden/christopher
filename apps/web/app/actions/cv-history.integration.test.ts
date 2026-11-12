import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { createTestDb } from "@/test/db";
import { ensureTestUser } from "@/test/auth";
import { sql } from "drizzle-orm";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let currentUserId = "";
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: currentUserId }) }));
import { readCvHistoryPage } from "./cv-history";

beforeAll(async () => { const client = createTestDb(); database = client.db; pool = client.pool;
  await runMigrations(database); }, 120_000);
afterAll(async () => { await pool?.end(); });
beforeEach(async () => { await database.execute(sql`truncate cv_drafts, cv_auto_baselines, cv_application_contexts, users restart identity cascade`); });

it("pages tied saved CVs by independent cursors, returns metadata only, and rejects another account", async () => {
  const owner = await ensureTestUser(database);
  const other = await ensureTestUser(database, "other@example.com");
  currentUserId = owner.id;
  const [context] = await database.insert(schema.cvApplicationContexts).values({ userId: owner.id,
    requestKey: `paste:${crypto.randomUUID()}`, jobTitle: "Analyst", companyName: "Example Co" }).returning();
  const [description] = await database.insert(schema.cvContextDescriptions).values({ userId: owner.id,
    contextId: context!.id, version: 1, text: "Analyse reports" }).returning();
  const library = { name: "Alex", contact: "London", profile: "Analyst", entries: [] };
  const snapshot = { version: 1, contextId: context!.id, descriptionVersionId: description!.id,
    jobTitle: "Analyst", companyName: "Example Co", description: "Analyse reports", library,
    basePriorityIdentity: "original", appearance: null, writingPreferences: {}, routes: {},
    contracts: { promptSet: "test", review: "test", fit: "test", render: "test" } };
  const sameTime = new Date("2026-11-02T10:00:00.000Z");
  await database.insert(schema.cvAutoBaselines).values(Array.from({ length: 31 }, (_, index) => ({ userId: owner.id,
    contextId: context!.id, descriptionVersionId: description!.id, inputKey: `history-${index}`,
    inputSnapshot: snapshot as never, engineContract: { ...snapshot.contracts, routes: {} },
    status: "failed" as const, createdAt: sameTime })));
  await database.insert(schema.cvDrafts).values(Array.from({ length: 30 }, (_, index) => ({ userId: owner.id,
    contextId: context!.id, descriptionVersionId: description!.id, jobTitle: "Analyst", companyName: "Example Co",
    jobDescription: "Analyse reports", libraryVersion: 1, librarySnapshot: library,
    model: "test", revision: index + 1, status: "ready" as const, createdAt: sameTime })));

  const first = await readCvHistoryPage(context!.id, {});
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.baselines).toHaveLength(25);
  expect(first.editions).toHaveLength(25);
  expect(first.older).not.toBeNull();
  expect(Object.keys(first.baselines[0]!)).toEqual(["id", "status", "descriptionVersionId", "createdAt", "publishedAt"]);
  expect(Object.keys(first.editions[0]!)).toEqual(["id", "status", "editingMode", "revision", "finalisedAt", "createdAt"]);
  const second = await readCvHistoryPage(context!.id, first.older!);
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.baselines).toHaveLength(6);
  expect(second.editions).toHaveLength(5);
  expect(second.older).toBeNull();
  expect(new Set([...first.baselines, ...second.baselines].map(row => row.id)).size).toBe(31);
  expect(new Set([...first.editions, ...second.editions].map(row => row.id)).size).toBe(30);
  currentUserId = other.id;
  expect(await readCvHistoryPage(context!.id, {})).toEqual({ ok: false, error: "Application not found." });
});
