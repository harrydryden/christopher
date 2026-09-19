/**
 * Documents on their way into the Library: recording one, handing it to the worker, recording what
 * the extraction made of it, and keeping the Library page's list short.
 *
 * Two helpers here take no `userId`, and the exception is narrow and deliberate.
 * `getLibraryImportForWorker` and `completeLibraryImport` are the worker's, and the worker
 * addresses an import by the id its task payload carries; the row it reads back carries the
 * account, so everything the handler writes afterwards is still scoped by one. Everything a page
 * or an action touches is scoped by account here, as every other per-account read is.
 *
 * The bytes of an upload are the one thing these reads hide. They exist to carry a PDF or a DOCX
 * from the interface to the worker and are cleared the moment the conversion is recorded, so only
 * the worker's own read returns them and no per-account query pays for them.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { normalizeUrl } from "@christopher/core";
import type { Db } from "./client";
import { libraryImports, LIBRARY_IMPORT_MAX_CHARS, type LibraryImport, type LibraryImportKind } from "./schema";

/** An import as the interface reads it: everything except the upload it may still be carrying. */
export type LibraryImportRow = Omit<LibraryImport, "sourceBytes">;
/** The same without the document's text, which a list of proposals has no use for. */
export type LibraryImportSummary = Omit<LibraryImportRow, "content">;

const summaryColumns = {
  id: libraryImports.id,
  userId: libraryImports.userId,
  kind: libraryImports.kind,
  filename: libraryImports.filename,
  url: libraryImports.url,
  sourceMime: libraryImports.sourceMime,
  fingerprint: libraryImports.fingerprint,
  proposal: libraryImports.proposal,
  error: libraryImports.error,
  processedAt: libraryImports.processedAt,
  resolvedAt: libraryImports.resolvedAt,
  createdAt: libraryImports.createdAt,
};
const rowColumns = { ...summaryColumns, content: libraryImports.content };

export interface CreateLibraryImportInput {
  userId: string;
  kind: LibraryImportKind;
  /** What the upload was called, so the person recognises the import. */
  filename?: string | null;
  /** The person's own site, for a `website` import. */
  url?: string | null;
  /** The text itself, for a paste. Longer text is truncated to `LIBRARY_IMPORT_MAX_CHARS`, as the interface does. */
  content?: string | null;
  /** The uploaded PDF or DOCX, which the worker converts to text and then clears. */
  sourceBytes?: Buffer | Uint8Array | null;
  sourceMime?: string | null;
}

/**
 * sha256 of whatever the import was given: the bytes for an upload, the stored text for a paste,
 * the normalised URL for a website. The text is hashed after truncation, so the fingerprint always
 * describes what is stored, and the URL is normalised so a tracking parameter does not make the
 * same page look like a new document.
 */
function fingerprintOf(input: CreateLibraryImportInput, content: string | null): string {
  if (input.sourceBytes) return createHash("sha256").update(Buffer.from(input.sourceBytes)).digest("hex");
  if (content) return createHash("sha256").update(content).digest("hex");
  if (input.url) return createHash("sha256").update(normalizeUrl(input.url)).digest("hex");
  throw new Error("createLibraryImport: an import needs an upload, some text or a URL");
}

/**
 * Record a document to import and return the row to enqueue work against.
 *
 * Importing the same document twice is a mistake, not a second document: the fingerprint is unique
 * per account, so a repeat returns the first import with `duplicate: true` rather than throwing or
 * queueing another extraction of the same words. The caller decides what to say about it — usually
 * "you have already imported this" beside the proposal that is still waiting.
 */
export async function createLibraryImport(
  db: Db,
  input: CreateLibraryImportInput,
  now = new Date(),
): Promise<LibraryImportRow & { duplicate: boolean }> {
  const content = input.content == null ? null : input.content.slice(0, LIBRARY_IMPORT_MAX_CHARS);
  const fingerprint = fingerprintOf(input, content);
  const [created] = await db
    .insert(libraryImports)
    .values({
      userId: input.userId,
      kind: input.kind,
      filename: input.filename ?? null,
      url: input.url ?? null,
      content,
      sourceBytes: input.sourceBytes ? Buffer.from(input.sourceBytes) : null,
      sourceMime: input.sourceMime ?? null,
      fingerprint,
      createdAt: now,
    })
    .onConflictDoNothing({ target: [libraryImports.userId, libraryImports.fingerprint] })
    .returning(rowColumns);
  if (created) return { ...created, duplicate: false };
  const [existing] = await db
    .select(rowColumns)
    .from(libraryImports)
    .where(and(eq(libraryImports.userId, input.userId), eq(libraryImports.fingerprint, fingerprint)))
    .limit(1);
  if (!existing) throw new Error("createLibraryImport: the import was neither created nor found");
  return { ...existing, duplicate: true };
}

/** One import, this account's. Never the upload's bytes: the interface has no use for them. */
export async function getLibraryImport(db: Db, userId: string, id: string): Promise<LibraryImportRow | null> {
  const [row] = await db
    .select(rowColumns)
    .from(libraryImports)
    .where(and(eq(libraryImports.id, id), eq(libraryImports.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * The imports the Library page still has something to say about, newest first.
 *
 * Open means unresolved: the person has neither accepted nor dismissed what came of it. Each row
 * is in one of three states, told apart without another query —
 *   unprocessed: `processed_at` is null, the worker has not finished with it;
 *   failed: `error` is not null, and the page should say so and offer to dismiss it;
 *   proposed: `proposal` is not null, and the page shows what was found with per-item controls.
 * Capped, because this is a page's list and not a history: resolved imports are gone from it, and
 * `pruneLibraryImports` keeps the table itself from growing.
 */
export async function listOpenLibraryImports(db: Db, userId: string, limit = 20): Promise<LibraryImportSummary[]> {
  return db
    .select(summaryColumns)
    .from(libraryImports)
    .where(and(eq(libraryImports.userId, userId), isNull(libraryImports.resolvedAt)))
    .orderBy(desc(libraryImports.createdAt))
    .limit(Math.max(1, Math.floor(limit)));
}

/**
 * One import with its upload, for the worker.
 *
 * No `userId`, because the task payload carries the import id and this is the read that resolves
 * it; the row carries the account, which is what the handler scopes every later write by. Reading
 * does not consume the bytes — only `completeLibraryImport` clears them — so a task that is
 * retried after a crash still has the document it was given.
 */
export async function getLibraryImportForWorker(db: Db, id: string): Promise<LibraryImport | null> {
  const [row] = await db.select().from(libraryImports).where(eq(libraryImports.id, id)).limit(1);
  return row ?? null;
}

/** What the worker made of an import: a proposal, or the reason there is none. */
export type LibraryImportOutcome =
  | {
      proposal: unknown;
      /** The text the worker converted or fetched, when it was the worker that produced it. */
      content?: string | null;
    }
  | { error: string; content?: string | null };

/**
 * Record what the extraction produced and stop the import waiting.
 *
 * It takes the id alone, and no `userId`, because the worker's task payload carries the import id:
 * this is the write at the end of that task. It sets `processed_at` either way, and it always
 * clears `source_bytes` and `source_mime` — on a proposal and on an error alike — so nothing
 * binary outlives the conversion, whether the conversion worked or not. A retry that needs the
 * document again re-imports it rather than re-reading bytes the product no longer keeps.
 *
 * Returns the row as it now stands, or null when there is no such import (it was deleted while the
 * task ran).
 */
export async function completeLibraryImport(
  db: Db,
  id: string,
  outcome: LibraryImportOutcome,
  now = new Date(),
): Promise<LibraryImportSummary | null> {
  const result = "error" in outcome
    ? { proposal: null, error: outcome.error.slice(0, 500) }
    : { proposal: outcome.proposal, error: null };
  const [row] = await db
    .update(libraryImports)
    .set({
      ...result,
      ...(outcome.content === undefined
        ? {}
        : { content: outcome.content == null ? null : outcome.content.slice(0, LIBRARY_IMPORT_MAX_CHARS) }),
      sourceBytes: null,
      sourceMime: null,
      processedAt: now,
    })
    .where(eq(libraryImports.id, id))
    .returning(summaryColumns);
  return row ?? null;
}

/**
 * The person has finished with this import: they accepted what they wanted and dismissed the rest.
 * Scoped by account, and true only when this call was the one that closed it, so a double submit
 * does not read as two resolutions.
 */
export async function resolveLibraryImport(db: Db, userId: string, id: string, now = new Date()): Promise<boolean> {
  const moved = await db
    .update(libraryImports)
    .set({ resolvedAt: now })
    .where(and(eq(libraryImports.id, id), eq(libraryImports.userId, userId), isNull(libraryImports.resolvedAt)))
    .returning({ id: libraryImports.id });
  return moved.length > 0;
}

/**
 * Keep this account's newest `keep` resolved imports and delete the rest, with the documents they
 * carry. Only resolved rows are eligible: an import still waiting for the worker or for the person
 * is live, however old it is, and deleting one would lose work nobody has looked at yet. Returns
 * how many rows went.
 */
export async function pruneLibraryImports(db: Db, userId: string, keep = 20): Promise<number> {
  const stale = await db
    .select({ id: libraryImports.id })
    .from(libraryImports)
    .where(and(eq(libraryImports.userId, userId), isNotNull(libraryImports.resolvedAt)))
    .orderBy(desc(libraryImports.createdAt))
    .offset(Math.max(0, Math.floor(keep)));
  if (!stale.length) return 0;
  const deleted = await db
    .delete(libraryImports)
    .where(and(eq(libraryImports.userId, userId), inArray(libraryImports.id, stale.map(row => row.id))))
    .returning({ id: libraryImports.id });
  return deleted.length;
}
