import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { industryDescriptions, normaliseCvLibrary, responsibilityRows } from "@col/core/cv";
import type { Db } from "./client";
import { latestCvLibrary } from "./cv-library";
import { lockAccountScoreInput } from "./score-fence";
import { careerAssertions, careerChanges, careerHeads, careerLinks, careerObjectVersions, careerRecords } from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Stable one-time identities; never regenerated from a later row position. */
export function legacyCareerId(userId: string, kind: string, oldId: string): string {
  const chars = createHash("sha256").update(`${userId}\0${kind}\0${oldId}`).digest("hex").slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = "8";
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** Initialise from the most recent saved Library, retaining every old JSON version unchanged. */
export async function ensureCareerBackfill(db: Db, userId: string): Promise<void> {
  const [existing] = await db.select({ migratedLibraryVersion: careerHeads.migratedLibraryVersion })
    .from(careerHeads).where(eq(careerHeads.userId, userId)).limit(1);
  if (existing?.migratedLibraryVersion !== null && existing?.migratedLibraryVersion !== undefined) return;
  await db.transaction(async tx => {
    await lockAccountScoreInput(tx as unknown as Db, userId, "exclusive");
    await tx.insert(careerHeads).values({ userId }).onConflictDoNothing();
    const [head] = await tx.select().from(careerHeads).where(eq(careerHeads.userId, userId)).for("update").limit(1);
    if (!head || head.migratedLibraryVersion !== null) return;
    const saved = await latestCvLibrary(tx as unknown as Db, userId);
    if (!saved) {
      await tx.update(careerHeads).set({ migratedLibraryVersion: 0 }).where(eq(careerHeads.userId, userId));
      return;
    }
    const library = normaliseCvLibrary(saved.content);
    const after: Record<string, unknown> = {};
    const touched: Array<{ kind: "record" | "link" | "assertion"; id: string; row: Record<string, unknown> }> = [];
    for (const job of library.employment ?? []) {
      const organisationId = legacyCareerId(userId, "organisation", job.id);
      const roleId = legacyCareerId(userId, "role", job.id);
      const narrative = library.entries.find(entry => entry.kind === "experience" && entry.employmentId === job.id)?.details ?? "";
      const roleEntries = library.entries.filter(entry => entry.kind === "experience" && entry.employmentId === job.id);
      const roleInactive = roleEntries.length > 0 && roleEntries.every(entry => entry.status === "inactive");
      const [organisation] = await tx.insert(careerRecords).values({ id: organisationId, userId, kind: "organisation",
        revision: 1, fields: { title: job.company.trim() || "Organisation not specified", originalNarrative: "", dates: { start: null, end: null, current: false },
          arrangement: null, publicLabel: null, confidential: false, industries: industryDescriptions(job.industryDescriptions) },
        provenance: { kind: "legacy_saved", sourceId: `cv_library:${saved.version}:employment:${job.id}`,
          quote: null, originalText: job.company, captureContext: `cv_library:${saved.version}` } }).returning();
      const [role] = await tx.insert(careerRecords).values({ id: roleId, userId, kind: "role", revision: 1,
        fields: { title: job.jobTitle.trim() || "Role not specified", originalNarrative: narrative,
          dates: { start: job.startDate || null, end: job.endDate || null, current: job.current },
          arrangement: "employment", publicLabel: null, confidential: false, industries: [] },
        provenance: { kind: "legacy_saved", sourceId: `cv_library:${saved.version}:employment:${job.id}`,
          quote: null, originalText: narrative, captureContext: `cv_library:${saved.version}` },
        archivedAt: roleInactive ? new Date() : null }).returning();
      const linkId = legacyCareerId(userId, "employed_by", job.id);
      const [link] = await tx.insert(careerLinks).values({ id: linkId, userId, fromId: roleId, toId: organisationId,
        kind: "employed_by", revision: 1, confidential: false, publicLabel: null }).returning();
      for (const [kind, id, row] of [["record", organisationId, organisation], ["record", roleId, role], ["link", linkId, link]] as const) {
        after[`${kind}:${id}`] = row;
        touched.push({ kind, id, row: JSON.parse(JSON.stringify(row)) as Record<string, unknown> });
      }
    }
    for (const entry of saved.content.entries) {
      const linkedEmploymentId = library.entries.find(candidate => candidate.id === entry.id)?.employmentId;
      const subjectId = entry.kind === "experience" && linkedEmploymentId
        ? legacyCareerId(userId, "role", linkedEmploymentId)
        : legacyCareerId(userId, entry.kind, entry.id);
      if (entry.kind !== "experience") {
        const kind = entry.kind === "education" ? "qualification" : entry.kind === "training" ? "learning"
          : entry.kind === "skill" ? "skill" : "other";
        const [record] = await tx.insert(careerRecords).values({ id: subjectId, userId, kind, revision: 1,
          fields: { title: entry.heading, originalNarrative: entry.details, dates: { start: null, end: null, current: false },
            arrangement: null, publicLabel: null, confidential: false, industries: [] },
          provenance: { kind: "legacy_saved", sourceId: `cv_library:${saved.version}:entry:${entry.id}`,
            quote: null, originalText: entry.details, captureContext: `cv_library:${saved.version}` },
          archivedAt: entry.status === "inactive" ? new Date() : null }).returning();
        after[`record:${subjectId}`] = record;
        touched.push({ kind: "record", id: subjectId, row: JSON.parse(JSON.stringify(record)) as Record<string, unknown> });
      }
      const factRows = entry.kind === "skill" && entry.skillItems?.length
        ? entry.skillItems : responsibilityRows(entry.details);
      for (const [index, text] of factRows.entries()) {
        const id = legacyCareerId(userId, "assertion", `${entry.id}:${index}:${text}`);
        const [row] = await tx.insert(careerAssertions).values({ id, userId, subjectId, revision: 1, text,
          publicText: null, facets: entry.kind === "skill" ? ["skill"] : entry.rowFacets?.[text] ?? [],
          status: entry.status === "inactive" ? "retracted" : "usable",
          provenance: { kind: "legacy_saved", sourceId: `entry:${entry.id}:row:${index}`, quote: null,
            originalText: text, captureContext: `cv_library:${saved.version}` } }).returning();
        after[`assertion:${id}`] = row;
        touched.push({ kind: "assertion", id, row: JSON.parse(JSON.stringify(row)) as Record<string, unknown> });
      }
    }
    const changeId = randomUUID();
    await tx.insert(careerChanges).values({ id: changeId, userId, revision: head.revision + 1,
      requestKey: `legacy:library:${saved.version}`, intentHash: createHash("sha256").update(`legacy:${userId}:${saved.version}`).digest("hex"),
      operations: [], before: {}, after });
    for (const item of touched) await tx.insert(careerObjectVersions).values({ userId, objectKind: item.kind,
      objectId: item.id, revision: 1, changeId, snapshot: item.row });
    await tx.update(careerHeads).set({ revision: head.revision + 1, migratedLibraryVersion: saved.version,
      updatedAt: new Date() }).where(eq(careerHeads.userId, userId));
  });
}
