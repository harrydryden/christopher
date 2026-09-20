/**
 * The documents this account has on their way into the Library, as the Library page reads them.
 *
 * Every read here is scoped by account, as every per-account read is: an import carries somebody's
 * CV, and it belongs to them alone. The data layer in `@christopher/db` does the work; this turns
 * its rows into the views the page renders and keeps the page to one query.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { listOpenLibraryImports, getLibraryImport } from "@christopher/db";
import { libraryImports } from "@christopher/db/schema";
import { db } from "@/lib/db";
import { libraryImportView, type LibraryImportView } from "@/lib/library-import";

/**
 * The imports the page still has something to say about, newest first.
 *
 * A second, narrow query asks which of the refused ones still carry their text, because that is
 * what decides whether the card offers to read it again; it runs only when something failed, and
 * reads one boolean per row rather than the documents themselves.
 */
export async function listLibraryImports(userId: string, limit = 10): Promise<LibraryImportView[]> {
  const rows = await listOpenLibraryImports(db(), userId, limit);
  const failed = rows.filter(row => row.error).map(row => row.id);
  const kept = failed.length
    ? new Set((await db()
        .select({ id: libraryImports.id, kept: sql<boolean>`${libraryImports.content} is not null` })
        .from(libraryImports)
        .where(and(eq(libraryImports.userId, userId), inArray(libraryImports.id, failed))))
      .filter(row => row.kept).map(row => row.id))
    : new Set<string>();
  return rows.map(row => libraryImportView(row, kept.has(row.id)));
}

/** One import of this account's, with the document it was read from. */
export async function getOwnLibraryImport(userId: string, id: string) {
  return getLibraryImport(db(), userId, id);
}

/** Is anything still being read? The page polls itself while this is true. */
export async function libraryImportsPending(userId: string): Promise<boolean> {
  const rows = await listOpenLibraryImports(db(), userId, 10);
  return rows.some(row => !row.processedAt);
}

/**
 * Put an import back in the queue's way: read this document again.
 *
 * The text is already on the row — a fetched page, a converted upload, a paste — so reading it
 * again costs one model call and no second upload. That is what "Try again" does after a budget
 * refusal, and what importing the same document twice does after the first attempt was refused or
 * finished with.
 *
 * Callers only ever reach here for an import that failed or was resolved; an import carrying a
 * proposal is the person's to accept or dismiss, and clearing one would throw away what they were
 * looking at. Scoped by account, like every write to this table.
 */
export async function reopenLibraryImport(userId: string, id: string): Promise<boolean> {
  const moved = await db()
    .update(libraryImports)
    .set({ error: null, proposal: null, processedAt: null, resolvedAt: null })
    .where(and(eq(libraryImports.id, id), eq(libraryImports.userId, userId)))
    .returning({ id: libraryImports.id });
  return moved.length > 0;
}
