import { and, eq, sql } from "drizzle-orm";
import { CV_REFINEMENT_LIMITS, CvRefinementSchema, type CvRefinementV1 } from "@col/core/cv-editing-modes";
import type { Db } from "./client";
import { cvApplicationContexts, cvRefinementEvents } from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class CvRefinementConflict extends Error {
  readonly userFacing = true as const;
}

/** Events remain immutable; each stable ID's highest version is its current value. */
export async function currentCvRefinements(tx: Tx, userId: string, contextId: string,
  includeReset = false): Promise<CvRefinementV1[]> {
  const rows = await tx.execute<{ refinement: unknown }>(sql`
    select distinct on (stable_id) refinement
    from cv_refinement_events
    where user_id = ${userId}::uuid and context_id = ${contextId}::uuid
    order by stable_id, version desc
  `);
  return rows.rows.map(row => CvRefinementSchema.parse(row.refinement))
    .filter(row => includeReset || !row.reset)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** The context lock serialises saves, resets and generation snapshots. */
export async function appendCvRefinement(tx: Tx, input: { userId: string; contextId: string;
  expectedVersion: number; refinement: CvRefinementV1 }): Promise<{ version: number; active: CvRefinementV1[] }> {
  const parsed = CvRefinementSchema.parse(input.refinement);
  const [context] = await tx.select().from(cvApplicationContexts).where(and(
    eq(cvApplicationContexts.id, input.contextId), eq(cvApplicationContexts.userId, input.userId),
  )).for("update");
  if (!context || context.refinementsVersion !== input.expectedVersion)
    throw new CvRefinementConflict("These refinements changed. Reload the application before saving.");
  const existing = await currentCvRefinements(tx, input.userId, input.contextId, true);
  const prior = existing.find(row => row.id === parsed.id);
  if (parsed.version !== (prior?.version ?? 0) + 1)
    throw new CvRefinementConflict("This refinement version changed. Reload the application.");
  const next = existing.filter(row => row.id !== parsed.id && !row.reset);
  if (!parsed.reset) next.push(parsed);
  const instructions = next.filter(row => row.kind === "instruction");
  if (instructions.length > CV_REFINEMENT_LIMITS.instructions ||
    instructions.reduce((sum, row) => sum + (row.text?.length ?? 0), 0) > CV_REFINEMENT_LIMITS.instructionCharacters)
    throw new CvRefinementConflict("Too many refinement instructions. Reset one before adding another.");
  await tx.insert(cvRefinementEvents).values({ userId: input.userId, contextId: input.contextId,
    stableId: parsed.id, version: parsed.version, refinement: parsed });
  const [updated] = await tx.update(cvApplicationContexts).set({ refinementsVersion: sql`${cvApplicationContexts.refinementsVersion} + 1` })
    .where(and(eq(cvApplicationContexts.id, input.contextId), eq(cvApplicationContexts.userId, input.userId)))
    .returning({ version: cvApplicationContexts.refinementsVersion });
  if (!updated) throw new CvRefinementConflict("This application changed before saving.");
  return { version: updated.version, active: await currentCvRefinements(tx, input.userId, input.contextId) };
}
