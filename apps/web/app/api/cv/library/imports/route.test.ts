/**
 * How this account's Library imports in flight stand, as the import poller reads them.
 *
 * It is this account's alone, it is never cached, and its fingerprint moves when an import is
 * answered and not otherwise: that is what lets the Library refresh once when a document lands
 * rather than on every tick while it is read.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, createLibraryImport, schema, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
let other: User;
const auth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("@/lib/auth", () => ({ requireUser: auth }));
import { GET } from "./route";

const DOCUMENT = "Jane Okafor, Director of Operations at Acme Logistics. Ran the UK warehouse team of 30 through a move to a new site.";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(async () => {
  if (database) await database.execute(sql`truncate library_imports, users cascade`);
  await pool?.end();
});
beforeEach(async () => {
  await database.execute(sql`truncate library_imports, users restart identity cascade`);
  user = await ensureTestUser(database, "library-imports-route@example.com");
  other = await ensureTestUser(database, "library-imports-stranger@example.com", "member");
  auth.mockReset();
  auth.mockResolvedValue(user);
});

async function progress() {
  const response = await GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return (await response.json()) as { reading: number; signature: string };
}

it("answers 401 without a session", async () => {
  auth.mockRejectedValue(new Error("Unauthorised"));
  const response = await GET();
  expect(response.status).toBe(401);
});

it("counts only this account's imports, and moves when one is answered and not before", async () => {
  const empty = await progress();
  expect(empty.reading).toBe(0);

  // Another account's import is invisible here.
  await createLibraryImport(database, { userId: other.id, kind: "paste", content: DOCUMENT });
  expect(await progress()).toEqual(empty);

  const row = await createLibraryImport(database, { userId: user.id, kind: "paste", content: DOCUMENT });
  const reading = await progress();
  expect(reading.reading).toBe(1);
  expect(reading.signature).not.toBe(empty.signature);
  // Nothing happened: the same answer, so the poller leaves the page alone.
  expect(await progress()).toEqual(reading);

  // The worker answers it with a proposal.
  await database.update(schema.libraryImports)
    .set({ proposal: { employment: [], education: [], skills: [] }, processedAt: new Date() })
    .where(eq(schema.libraryImports.id, row.id));
  const answered = await progress();
  expect(answered.reading).toBe(0);
  expect(answered.signature).not.toBe(reading.signature);

  // Another account's import being answered does not move this one's.
  await database.update(schema.libraryImports).set({ proposal: {}, processedAt: new Date() })
    .where(eq(schema.libraryImports.userId, other.id));
  expect(await progress()).toEqual(answered);
});
