import { desc, eq } from "drizzle-orm";
import type { SelectedFields } from "drizzle-orm/pg-core";
import type { SelectResultFields } from "drizzle-orm/query-builders/select.types";
import type { Db } from "./client";
import { cvLibraries } from "./schema";

const VERSION_AND_CONTENT = { version: cvLibraries.version, content: cvLibraries.content };

/**
 * One account's newest saved CV library, or null when it has saved none. Libraries are immutable
 * versions, so "the library" is always the highest version; `columns` narrows what is read.
 */
export async function latestCvLibrary<C extends SelectedFields = typeof VERSION_AND_CONTENT>(db: Db, userId: string, columns?: C): Promise<SelectResultFields<C> | null> {
  const [row] = await db.select((columns ?? VERSION_AND_CONTENT) as SelectedFields).from(cvLibraries)
    .where(eq(cvLibraries.userId, userId)).orderBy(desc(cvLibraries.version)).limit(1);
  return (row ?? null) as SelectResultFields<C> | null;
}
