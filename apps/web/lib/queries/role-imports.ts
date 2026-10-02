import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { roleImports, tasks } from "@ava/db";
import { db } from "@/lib/db";

/** The review page may read the extracted proposal, but never an uploaded PDF's bytes. */
const visible = {
  id: roleImports.id,
  kind: roleImports.kind,
  url: roleImports.url,
  filename: roleImports.filename,
  status: roleImports.status,
  title: roleImports.title,
  companyName: roleImports.companyName,
  location: roleImports.location,
  descriptionText: roleImports.descriptionText,
  truncated: roleImports.truncated,
  error: roleImports.error,
  jobId: roleImports.jobId,
  createdAt: roleImports.createdAt,
  updatedAt: roleImports.updatedAt,
};

export async function getRoleImport(userId: string, id: string) {
  const [row] = await db().select(visible).from(roleImports)
    .where(and(eq(roleImports.userId, userId), eq(roleImports.id, id))).limit(1);
  if (!row || row.status !== "queued") return row ?? null;
  const taskScope = and(eq(tasks.type, "import_role_description"), sql`${tasks.payload}->>'userId' = ${userId}`,
    sql`${tasks.payload}->>'importId' = ${id}`);
  const [active] = await db().select({ id: tasks.id }).from(tasks)
    .where(and(taskScope, inArray(tasks.status, ["queued", "running"]))).limit(1);
  if (active) return row;
  const [latest] = await db().select({ status: tasks.status }).from(tasks)
    .where(taskScope).orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  return latest?.status === "failed" ? { ...row, status: "failed" as const,
    error: "The role could not be read. Retry or paste the full description." } : row;
}

export type VisibleRoleImport = NonNullable<Awaited<ReturnType<typeof getRoleImport>>>;

/** Recent unfinished imports are a recovery path if a navigation was interrupted. */
export async function listRecentRoleImports(userId: string, limit = 10) {
  const { descriptionText: _descriptionText, ...summary } = visible;
  return db().select(summary).from(roleImports).where(eq(roleImports.userId, userId))
    .orderBy(desc(roleImports.createdAt), desc(roleImports.id)).limit(Math.max(1, Math.min(limit, 20)));
}
