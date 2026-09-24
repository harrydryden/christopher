/**
 * What the Library page reads about the documents on their way in: this account's, newest first,
 * in the state the row says they are in.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, createLibraryImport, schema, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import type { User } from "@ava/db/schema";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
let other: User;
vi.mock("@/lib/db", () => ({ db: () => database }));

import { getOwnLibraryImport, libraryImportsPending, listLibraryImports, reopenLibraryImport } from "./library-imports";

const DOCUMENT = "Director of Operations, Acme Logistics. Cut handover time from two days to four hours.";
const at = (minutes: number) => new Date(Date.parse("2026-09-19T09:00:00Z") + minutes * 60_000);

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  user = await ensureTestUser(database, "library-import-queries@example.com");
  other = await ensureTestUser(database, "library-import-queries-other@example.com", "member");
});

afterAll(async () => {
  // With the accounts it opened, so the next file starts from the database it expects.
  if (database) await database.execute(sql`truncate library_imports, users cascade`);
  await pool?.end();
});

beforeEach(async () => {
  await database.execute(sql`truncate library_imports restart identity cascade`);
});

it("lists this account's open imports, newest first, in the state each is in", async () => {
  const reading = await createLibraryImport(database, { userId: user.id, kind: "paste", content: DOCUMENT }, at(0));
  const proposed = await createLibraryImport(database, { userId: user.id, kind: "cv", filename: "cv.pdf", sourceBytes: Buffer.from("%PDF-1.7 ...") }, at(1));
  await database.update(schema.libraryImports).set({
    processedAt: at(2), sourceBytes: null, content: DOCUMENT,
    proposal: { employment: [{ id: "job-0", company: "Acme Logistics", title: "Director of Operations", startDate: "", endDate: "", current: false, quote: "Director of Operations", responsibilities: [] }], education: [], skills: [] },
  }).where(eq(schema.libraryImports.id, proposed.id));
  // Somebody else's import, which must never appear here.
  await createLibraryImport(database, { userId: other.id, kind: "paste", content: "Somebody else's CV entirely." }, at(3));

  const views = await listLibraryImports(user.id);

  expect(views.map(view => [view.id, view.state])).toEqual([[proposed.id, "proposed"], [reading.id, "reading"]]);
  expect(views[0]!.headline).toBe("Found in cv.pdf: 1 job");
  expect(views[1]!.headline).toBe("Reading Pasted text…");
  expect(await libraryImportsPending(user.id)).toBe(true);
});

it("offers to read a refusal again only when the text is still on the row", async () => {
  const kept = await createLibraryImport(database, { userId: user.id, kind: "paste", content: DOCUMENT }, at(0));
  const lost = await createLibraryImport(database, { userId: user.id, kind: "cv", filename: "scan.pdf", sourceBytes: Buffer.from("%PDF-nope") }, at(1));
  for (const id of [kept.id, lost.id]) {
    await database.update(schema.libraryImports).set({ error: "Could not read that.", processedAt: at(2), sourceBytes: null })
      .where(eq(schema.libraryImports.id, id));
  }

  const views = await listLibraryImports(user.id);

  expect(views.map(view => [view.state, view.retryable])).toEqual([["failed", false], ["failed", true]]);
  // Nothing is waiting on the worker any more, so the page stops asking.
  expect(await libraryImportsPending(user.id)).toBe(false);
});

it("reads and reopens one import for its own account and nobody else's", async () => {
  const row = await createLibraryImport(database, { userId: user.id, kind: "paste", content: DOCUMENT }, at(0));
  await database.update(schema.libraryImports).set({ error: "Budget spent.", processedAt: at(1), resolvedAt: at(1) })
    .where(eq(schema.libraryImports.id, row.id));

  expect(await getOwnLibraryImport(other.id, row.id)).toBeNull();
  expect(await reopenLibraryImport(other.id, row.id)).toBe(false);
  expect((await getOwnLibraryImport(user.id, row.id))!.error).toBe("Budget spent.");

  expect(await reopenLibraryImport(user.id, row.id)).toBe(true);
  expect(await getOwnLibraryImport(user.id, row.id)).toMatchObject({ error: null, proposal: null, processedAt: null, resolvedAt: null, content: DOCUMENT });
  // Reopened, so it is back on the page and the worker is expected to answer for it.
  expect((await listLibraryImports(user.id)).map(view => view.state)).toEqual(["reading"]);
});

it("says nothing is happening for an account with no imports", async () => {
  expect(await listLibraryImports(user.id)).toEqual([]);
  expect(await libraryImportsPending(user.id)).toBe(false);
});
