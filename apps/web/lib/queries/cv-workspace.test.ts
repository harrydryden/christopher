import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { createTestDb } from "@/test/db";
import { ensureTestUser } from "@/test/auth";
import { sql } from "drizzle-orm";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
vi.mock("@/lib/db", () => ({ db: () => database }));
import { getOwnCvWorkspace } from "./cv-workspace";

beforeAll(async () => { const client = createTestDb(); database = client.db; pool = client.pool;
  await runMigrations(database); }, 120_000);
afterAll(async () => { await pool?.end(); });
beforeEach(async () => { await database.execute(sql`truncate cv_drafts, cv_auto_baselines, cv_application_contexts, users restart identity cascade`); });

it("pages interleaved Auto and draft histories without losing tied timestamps or an old selection", async () => {
  const user = await ensureTestUser(database);
  const [context] = await database.insert(schema.cvApplicationContexts).values({ userId: user.id,
    requestKey: `paste:${crypto.randomUUID()}`, jobTitle: "Analyst", companyName: "Example Co" }).returning();
  const [description] = await database.insert(schema.cvContextDescriptions).values({ userId: user.id,
    contextId: context!.id, version: 1, text: "Analyse reports" }).returning();
  const library = { name: "Alex", contact: "London", profile: "Analyst", entries: [] };
  const sameTime = new Date("2026-11-02T10:00:00.000Z");
  const oldTime = new Date("2026-11-01T10:00:00.000Z");
  const inputSnapshot = { version: 1, contextId: context!.id, descriptionVersionId: description!.id,
    jobTitle: "Analyst", companyName: "Example Co", description: "Analyse reports", library,
    basePriorityIdentity: "original", appearance: null, writingPreferences: {}, routes: {},
    contracts: { promptSet: "test", review: "test", fit: "test", render: "test" } };
  const engineContract = { ...inputSnapshot.contracts, routes: {} };
  const [selected] = await database.insert(schema.cvAutoBaselines).values({ userId: user.id,
    contextId: context!.id, descriptionVersionId: description!.id, inputKey: "older",
    inputSnapshot: inputSnapshot as never, engineContract, status: "failed", createdAt: oldTime }).returning();
  await database.insert(schema.cvAutoBaselines).values(Array.from({ length: 31 }, (_, index) => ({ userId: user.id,
    contextId: context!.id, descriptionVersionId: description!.id, inputKey: `recent-${index}`,
    inputSnapshot: inputSnapshot as never, engineContract, status: "failed" as const, createdAt: sameTime })));
  await database.insert(schema.cvDrafts).values(Array.from({ length: 31 }, (_, index) => ({ userId: user.id,
    contextId: context!.id, descriptionVersionId: description!.id, jobTitle: "Analyst", companyName: "Example Co",
    jobDescription: "Analyse reports", libraryVersion: 1, librarySnapshot: library,
    model: "test", revision: index + 1, status: "ready" as const, createdAt: sameTime })));
  await database.update(schema.cvApplicationContexts).set({ selectedKind: "baseline", selectedId: selected!.id })
    .where(sql`${schema.cvApplicationContexts.id} = ${context!.id}`);

  const first = await getOwnCvWorkspace(user.id, context!.id);
  expect(first?.selected).toMatchObject({ kind: "baseline", id: selected!.id });
  expect(first?.baselines).toHaveLength(25);
  expect(first?.editions).toHaveLength(25);
  expect(first?.older).not.toBeNull();
  const second = await getOwnCvWorkspace(user.id, context!.id, first!.older!);
  expect(second?.baselines).toHaveLength(7);
  expect(second?.editions).toHaveLength(6);
  expect(second?.selected?.id).toBe(selected!.id);
  expect(new Set([...first!.baselines, ...second!.baselines].map(row => row.id)).size).toBe(32);
  expect(new Set([...first!.editions, ...second!.editions].map(row => row.id)).size).toBe(31);
  expect(second?.older).toBeNull();
});
