import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { careerCanonicalJson, careerPrivateRecordIds } from "@col/core/career-record";
import type { Db } from "./client";
import { careerAssertions, careerHeads, careerLinks, careerRecords } from "./schema";
import { ensureCareerBackfill } from "./career-backfill";

export type CareerRecommendationProfile = { version: number; hash: string;
  roles: string[]; skills: string[]; industries: string[]; terms: string[] };

const distinct = (values: string[]) => [...new Map(values.map(value => [value.trim().toLocaleLowerCase("en-GB"), value.trim()] as const)
  .filter(([key]) => key)).values()].sort((a, b) => a.localeCompare(b, "en-GB"));

/** All eligible private facts, independent of the capped CV compatibility snapshot. */
export async function getCareerRecommendationProfile(db: Db, userId: string): Promise<CareerRecommendationProfile | null> {
  await ensureCareerBackfill(db, userId);
  return db.transaction(async tx => {
    const [head] = await tx.select({ revision: careerHeads.revision }).from(careerHeads)
      .where(eq(careerHeads.userId, userId)).limit(1);
    if (!head) return null;
    const records = await tx.select({ id: careerRecords.id, kind: careerRecords.kind, archivedAt: careerRecords.archivedAt,
        title: sql<string>`${careerRecords.fields}->>'title'`,
        industries: sql<string[]>`coalesce(${careerRecords.fields}->'industries','[]'::jsonb)`,
        confidential: sql<boolean>`coalesce((${careerRecords.fields}->>'confidential')::boolean,false)`,
        provenanceKind: sql<string>`${careerRecords.provenance}->>'kind'` })
        .from(careerRecords).where(eq(careerRecords.userId, userId));
    const links = await tx.select({ fromId: careerLinks.fromId, toId: careerLinks.toId,
      kind: careerLinks.kind, confidential: careerLinks.confidential, archivedAt: careerLinks.archivedAt })
      .from(careerLinks).where(eq(careerLinks.userId, userId));
    const assertions = await tx.select({ subjectId: careerAssertions.subjectId, text: careerAssertions.text,
        provenanceKind: sql<string>`${careerAssertions.provenance}->>'kind'` })
        .from(careerAssertions).where(and(eq(careerAssertions.userId, userId),
          eq(careerAssertions.status, "usable"), sql`${careerAssertions.facets} ? 'skill'`));
    const hidden = careerPrivateRecordIds(records.map(record => ({ id: record.id,
      confidential: record.confidential })), links.map(link => ({ fromId: link.fromId,
      toId: link.toId, kind: link.kind, confidential: link.confidential, archived: !!link.archivedAt })));
    const visible = records.filter(record => !hidden.has(record.id) && !record.archivedAt && record.provenanceKind !== "model");
    const visibleIds = new Set(visible.map(record => record.id));
    const roles = distinct(visible.filter(record => record.kind === "role" || record.kind === "engagement")
      .map(record => record.title));
    const skills = distinct(assertions.filter(item => visibleIds.has(item.subjectId) && item.provenanceKind !== "model")
      .map(item => item.text));
    const industries = distinct(visible.flatMap(record => record.industries));
    const terms = distinct([...roles, ...skills, ...industries]);
    if (!terms.length) return null;
    const payload = { version: head.revision, roles, skills, industries, terms };
    return { ...payload, hash: createHash("sha256").update(careerCanonicalJson(payload)).digest("hex") };
  }, { isolationLevel: "repeatable read" });
}
