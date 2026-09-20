/**
 * Documents on their way into the Library, at the database: the same document is imported once per
 * account, the worker is handed the upload and gives back text, nothing binary outlives the
 * conversion, the page's list holds exactly what is still open, and pruning keeps the resolved ones
 * from piling up.
 *
 * It lives in the worker because the db package has no test runner of its own, as
 * `library-reviews.test.ts` does for the evidence reviews.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  completeLibraryImport, createDb, createLibraryImport, getLibraryImport, getLibraryImportForWorker,
  listOpenLibraryImports, pruneLibraryImports, resolveLibraryImport, schema,
  LIBRARY_IMPORT_MAX_BYTES, LIBRARY_IMPORT_MAX_CHARS, type Db,
} from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { sql } from "drizzle-orm";
import pg from "pg";
import { ensureTestUser } from "./test-users";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test";
/** Minutes from one fixed morning, so every ordering in here is the one the test wrote. */
const at = (minutes: number) => new Date(Date.parse("2026-09-19T09:00:00Z") + minutes * 60_000);
const MISSING_ID = "00000000-0000-4000-8000-000000000000";
const PASTED = "Operations Director at Acme. Cut handover time across the network by 40%.";

/** The constraint a write ran into. The driver names it; drizzle wraps the driver's error in its own. */
async function constraintOf(attempt: () => Promise<unknown>): Promise<string> {
  try {
    await attempt();
    return "accepted";
  } catch (error) {
    const cause = (error as { cause?: { constraint?: string } }).cause;
    return cause?.constraint ?? (error as Error).message;
  }
}

let db: Db;
let pool: pg.Pool;
let userId: string;
let otherId: string;

beforeAll(async () => {
  const created = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(created.db);
  db = created.db;
  pool = created.pool;
  userId = (await ensureTestUser(db, "library-imports@example.com")).id;
  otherId = (await ensureTestUser(db, "library-imports-other@example.com")).id;
}, 60_000);

afterAll(async () => { await pool?.end(); });

beforeEach(async () => { await db.execute(sql`truncate library_imports`); });

it("imports a document once per account, and reads a repeat back as the first import", async () => {
  const first = await createLibraryImport(db, { userId, kind: "paste", content: PASTED }, at(0));
  expect(first).toMatchObject({ userId, kind: "paste", duplicate: false, processedAt: null, resolvedAt: null, proposal: null, error: null });
  expect(first.fingerprint).toHaveLength(64);

  // The same words again are the same document, not a second extraction of them.
  const again = await createLibraryImport(db, { userId, kind: "paste", content: PASTED }, at(5));
  expect(again).toMatchObject({ id: first.id, duplicate: true, createdAt: first.createdAt });
  const other = await createLibraryImport(db, { userId, kind: "paste", content: "Head of Operations at Beta." }, at(6));
  expect(other.duplicate).toBe(false);

  // A website is fingerprinted by its normalised URL, so a tracking parameter is not a new page.
  const site = await createLibraryImport(db, { userId, kind: "website", url: "https://example.com/about/?utm_source=mail" }, at(7));
  expect(await createLibraryImport(db, { userId, kind: "website", url: "https://example.com/about" }, at(8))).toMatchObject({ id: site.id, duplicate: true });

  // Uniqueness is per account: another person's copy of the same CV is their own import.
  const theirs = await createLibraryImport(db, { userId: otherId, kind: "paste", content: PASTED }, at(9));
  expect(theirs).toMatchObject({ duplicate: false, userId: otherId });
  expect(theirs.id).not.toBe(first.id);

  // And one account cannot read another's import by id.
  expect(await getLibraryImport(db, otherId, first.id)).toBeNull();
  expect(await getLibraryImport(db, userId, first.id)).toMatchObject({ id: first.id, content: PASTED });
});

it("gives the worker the upload, takes back the text and the proposal, and keeps no bytes afterwards", async () => {
  const bytes = Buffer.from("%PDF-1.7 a past CV, in whatever a PDF is");
  const created = await createLibraryImport(db, { userId, kind: "cv", filename: "cv.pdf", sourceBytes: bytes, sourceMime: "application/pdf" }, at(0));
  expect(created).toMatchObject({ kind: "cv", filename: "cv.pdf", sourceMime: "application/pdf", content: null, duplicate: false });
  // The same file again is the same import, however it was named the second time.
  expect(await createLibraryImport(db, { userId, kind: "cv", filename: "cv (1).pdf", sourceBytes: bytes, sourceMime: "application/pdf" }, at(1)))
    .toMatchObject({ id: created.id, duplicate: true, filename: "cv.pdf" });

  // The worker addresses the import by the id on its task payload, and gets the document itself.
  const forWorker = await getLibraryImportForWorker(db, created.id);
  expect(forWorker!.userId).toBe(userId);
  expect(forWorker!.sourceBytes!.equals(bytes)).toBe(true);
  // The interface's read never carries them.
  expect(await getLibraryImport(db, userId, created.id)).not.toHaveProperty("sourceBytes");

  const proposal = { employment: [{ company: "Acme", jobTitle: "Operations Director" }], responsibilities: 17 };
  const done = await completeLibraryImport(db, created.id, { proposal, content: "Operations Director at Acme" }, at(2));
  expect(done).toMatchObject({ proposal, error: null, sourceMime: null, resolvedAt: null });
  expect(done!.processedAt!.toISOString()).toBe(at(2).toISOString());

  const after = await getLibraryImportForWorker(db, created.id);
  expect(after!.sourceBytes).toBeNull();
  expect(after!.sourceMime).toBeNull();
  expect(after!.content).toBe("Operations Director at Acme");
});

it("records a failure with no proposal, and clears the upload just the same", async () => {
  const created = await createLibraryImport(db, { userId, kind: "linkedin", filename: "profile.pdf", sourceBytes: Buffer.from("not really a pdf"), sourceMime: "application/pdf" }, at(0));
  expect(await completeLibraryImport(db, created.id, { error: "We could not read that file." }, at(1)))
    .toMatchObject({ proposal: null, error: "We could not read that file.", sourceMime: null });
  const row = await getLibraryImportForWorker(db, created.id);
  expect(row!.sourceBytes).toBeNull();
  expect(row!.content).toBeNull();

  // A long message is trimmed rather than refused: it is shown beside the import, not logged.
  await completeLibraryImport(db, created.id, { error: "x".repeat(900) }, at(2));
  expect((await getLibraryImport(db, userId, created.id))!.error).toHaveLength(500);

  // An import deleted while its task ran is not an error for the task that finishes afterwards.
  expect(await completeLibraryImport(db, MISSING_ID, { error: "gone" }, at(3))).toBeNull();
});

it("lists what the Library page still has something to say about, newest first and capped", async () => {
  const unprocessed = await createLibraryImport(db, { userId, kind: "paste", content: "waiting on the worker" }, at(1));
  const proposed = await createLibraryImport(db, { userId, kind: "paste", content: "already extracted" }, at(2));
  await completeLibraryImport(db, proposed.id, { proposal: { employment: [] } }, at(3));
  const failed = await createLibraryImport(db, { userId, kind: "paste", content: "could not be read" }, at(4));
  await completeLibraryImport(db, failed.id, { error: "We could not read that file." }, at(5));
  const resolved = await createLibraryImport(db, { userId, kind: "paste", content: "finished with" }, at(6));
  await completeLibraryImport(db, resolved.id, { proposal: { employment: [] } }, at(7));
  await resolveLibraryImport(db, userId, resolved.id, at(8));
  await createLibraryImport(db, { userId: otherId, kind: "paste", content: "someone else's document" }, at(9));

  const open = await listOpenLibraryImports(db, userId);
  expect(open.map(row => row.id)).toEqual([failed.id, proposed.id, unprocessed.id]);
  // The three states the page tells apart, each from the row it already has.
  expect(open[0]).toMatchObject({ error: "We could not read that file.", proposal: null });
  expect(open[1]!.proposal).toEqual({ employment: [] });
  expect(open[2]).toMatchObject({ processedAt: null, error: null, proposal: null });
  // A list of proposals does not carry the documents they came from.
  expect(open[0]).not.toHaveProperty("content");

  expect((await listOpenLibraryImports(db, userId, 2)).map(row => row.id)).toEqual([failed.id, proposed.id]);
  // Another account's imports are never in this one's list.
  expect((await listOpenLibraryImports(db, otherId)).map(row => row.userId)).toEqual([otherId]);
});

it("resolves once, and prunes the resolved imports beyond the newest few", async () => {
  const one = await createLibraryImport(db, { userId, kind: "paste", content: "the oldest document" }, at(1));
  expect(await resolveLibraryImport(db, otherId, one.id, at(2))).toBe(false);
  expect(await resolveLibraryImport(db, userId, one.id, at(2))).toBe(true);
  expect(await resolveLibraryImport(db, userId, one.id, at(3))).toBe(false);
  expect((await getLibraryImport(db, userId, one.id))!.resolvedAt!.toISOString()).toBe(at(2).toISOString());

  // Twenty-three more resolved imports, and one the person has not finished with.
  for (let n = 0; n < 24; n++) {
    const row = await createLibraryImport(db, { userId, kind: "paste", content: `document ${n}` }, at(10 + n));
    if (n < 23) await resolveLibraryImport(db, userId, row.id, at(10 + n));
  }
  const theirs = await createLibraryImport(db, { userId: otherId, kind: "paste", content: "their document" }, at(50));
  await resolveLibraryImport(db, otherId, theirs.id, at(51));

  expect(await pruneLibraryImports(db, userId, 20)).toBe(4);
  const kept = await db.select({ id: schema.libraryImports.id, resolvedAt: schema.libraryImports.resolvedAt })
    .from(schema.libraryImports).where(sql`user_id = ${userId}`);
  // Twenty resolved and the open one, which is kept however old it is.
  expect(kept).toHaveLength(21);
  expect(kept.filter(row => !row.resolvedAt)).toHaveLength(1);
  expect(kept.some(row => row.id === one.id)).toBe(false);

  // Idempotent, and another account's imports are never swept with this one's.
  expect(await pruneLibraryImports(db, userId, 20)).toBe(0);
  expect(await pruneLibraryImports(db, userId, 5)).toBe(15);
  expect(await pruneLibraryImports(db, otherId, 20)).toBe(0);
  expect(await getLibraryImport(db, otherId, theirs.id)).not.toBeNull();
});

it("caps what one import may carry, in the helper and again in the column", async () => {
  const huge = "a".repeat(LIBRARY_IMPORT_MAX_CHARS + 5_000);
  const created = await createLibraryImport(db, { userId, kind: "paste", content: huge }, at(0));
  expect((await getLibraryImport(db, userId, created.id))!.content).toHaveLength(LIBRARY_IMPORT_MAX_CHARS);
  // The text the worker converts is capped the same way.
  await completeLibraryImport(db, created.id, { proposal: {}, content: huge }, at(1));
  expect((await getLibraryImport(db, userId, created.id))!.content).toHaveLength(LIBRARY_IMPORT_MAX_CHARS);

  // An import with nothing in it is refused before it reaches the database.
  await expect(async () => { await createLibraryImport(db, { userId, kind: "paste" }, at(2)); }).rejects.toThrow(/upload, some text or a URL/);

  // And the columns say the same to anything that writes around the helpers.
  expect(await constraintOf(() => db.execute(sql`insert into library_imports (user_id, kind, content, fingerprint) values (${userId}, 'paste', ${"a".repeat(LIBRARY_IMPORT_MAX_CHARS + 1)}, 'over-long')`)))
    .toBe("library_imports_content_length_check");
  expect(await constraintOf(() => db.execute(sql`insert into library_imports (user_id, kind, fingerprint) values (${userId}, 'letter', 'unknown-kind')`)))
    .toBe("library_imports_kind_check");
  expect(await constraintOf(() => db.insert(schema.libraryImports).values({ userId, kind: "cv", fingerprint: "over-large", sourceBytes: Buffer.alloc(LIBRARY_IMPORT_MAX_BYTES + 1) })))
    .toBe("library_imports_source_bytes_length_check");
});
