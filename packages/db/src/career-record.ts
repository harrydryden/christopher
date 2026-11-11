import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { CareerChangeSchema, CareerRecordFieldsSchema, CareerProvenanceSchema, careerCanonicalJson, careerConflictingGroups,
  careerPrivateRecordIds, type CareerAssertionView, type CareerChange,
  type CareerChangeResult, type CareerConflictView, type CareerRecordView, type CareerWorkspace,
  type CareerProvenance } from "@col/core/career-record";
import type { Db } from "./client";
import { lockAccountScoreInput } from "./score-fence";
import { ensureCareerBackfill } from "./career-backfill";
import { legacyCareerId } from "./career-backfill";
import { careerCvEvidence } from "./career-cv";
import { latestCvLibrary } from "./cv-library";
import { careerAssertions, careerChanges, careerHeads, careerLinks, careerObjectVersions,
  careerPerspectives, careerRecords, cvLibraries, users } from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ObjectKind = "record" | "link" | "assertion" | "perspective";
type Row = Record<string, unknown>;
const snapshot = (value: unknown): Row | null => value == null ? null : JSON.parse(JSON.stringify(value)) as Row;
const objectKey = (kind: ObjectKind, id: string) => `${kind}:${id}`;
const hash = (value: unknown) => createHash("sha256").update(careerCanonicalJson(value)).digest("hex");
const direct = (text: string): CareerProvenance => ({ kind: "direct_user", sourceId: null, quote: null,
  originalText: text, captureContext: null });

export class CareerWriteConflict extends Error {
  constructor(message = "Experience changed. Reload this item before saving.") { super(message); }
}

async function headForUpdate(tx: Tx, userId: string) {
  await lockAccountScoreInput(tx as unknown as Db, userId, "exclusive");
  await tx.insert(careerHeads).values({ userId }).onConflictDoNothing();
  const [head] = await tx.select().from(careerHeads).where(eq(careerHeads.userId, userId)).for("update").limit(1);
  if (!head) throw new Error("Career head could not be locked.");
  return head;
}

async function ownedRecord(tx: Tx, userId: string, id: string) {
  const [row] = await tx.select().from(careerRecords).where(and(eq(careerRecords.userId, userId), eq(careerRecords.id, id))).for("update").limit(1);
  if (!row) throw new CareerWriteConflict("That Experience item no longer belongs to this account.");
  return row;
}
async function ownedAssertion(tx: Tx, userId: string, id: string) {
  const [row] = await tx.select().from(careerAssertions).where(and(eq(careerAssertions.userId, userId), eq(careerAssertions.id, id))).for("update").limit(1);
  if (!row) throw new CareerWriteConflict("That Experience fact no longer belongs to this account.");
  return row;
}
async function ownedLink(tx: Tx, userId: string, id: string) {
  const [row] = await tx.select().from(careerLinks).where(and(eq(careerLinks.userId, userId), eq(careerLinks.id, id))).for("update").limit(1);
  if (!row) throw new CareerWriteConflict("That Experience relationship no longer belongs to this account.");
  return row;
}
async function ownedPerspective(tx: Tx, userId: string, id: string) {
  const [row] = await tx.select().from(careerPerspectives).where(and(eq(careerPerspectives.userId, userId), eq(careerPerspectives.id, id))).for("update").limit(1);
  if (!row) throw new CareerWriteConflict("That perspective no longer belongs to this account.");
  return row;
}

async function assertNoPartOfCycle(tx: Tx, userId: string, fromId: string, toId: string) {
  const links = await tx.select({ fromId: careerLinks.fromId, toId: careerLinks.toId }).from(careerLinks)
    .where(and(eq(careerLinks.userId, userId), eq(careerLinks.kind, "part_of"), sql`${careerLinks.archivedAt} is null`));
  const adjacent = new Map<string, string[]>();
  for (const link of links) adjacent.set(link.fromId, [...(adjacent.get(link.fromId) ?? []), link.toId]);
  const visited = new Set<string>();
  const pending = [toId];
  while (pending.length) {
    const id = pending.pop()!;
    if (id === fromId) throw new CareerWriteConflict("This project relationship would form a cycle.");
    if (visited.has(id)) continue;
    visited.add(id);
    if (visited.size > 2000) throw new CareerWriteConflict("Too many connected projects to validate this relationship.");
    pending.push(...(adjacent.get(id) ?? []));
  }
}

/** One transaction owns the original input, object versions and change acknowledgement. */
export async function saveCareerChangeIn(tx: Tx, userId: string, raw: unknown,
  trustedProvenance: Readonly<Record<string, CareerProvenance>> = {}): Promise<CareerChangeResult> {
  const input = CareerChangeSchema.parse(raw);
  const intentHash = hash(input);
  const head = await headForUpdate(tx, userId);
  const [replay] = await tx.select().from(careerChanges)
    .where(and(eq(careerChanges.userId, userId), eq(careerChanges.requestKey, input.requestKey))).limit(1);
  if (replay) {
    if (replay.intentHash !== intentHash) throw new CareerWriteConflict("This save key was already used for different Experience changes.");
    return { ok: true, revision: replay.revision, changeId: replay.id,
      changedIds: Object.keys(replay.after).map(key => key.slice(key.indexOf(":") + 1)), conflicts: [] };
  }
  if (input.expectedRevision > head.revision) throw new CareerWriteConflict();
  const revision = head.revision + 1;
  const changeId = randomUUID();
  const before: Record<string, Row | null> = {};
  const after: Record<string, Row | null> = {};
  const touched: Array<{ kind: ObjectKind; id: string; revision: number; row: Row }> = [];
  const remember = (kind: ObjectKind, id: string, prior: unknown, next: unknown, nextRevision: number) => {
    const key = objectKey(kind, id);
    if (!(key in before)) before[key] = snapshot(prior);
    after[key] = snapshot(next);
    touched.push({ kind, id, revision: nextRevision, row: snapshot(next)! });
  };
  for (const operation of input.operations) {
    switch (operation.type) {
      case "create_record": {
        const [row] = await tx.insert(careerRecords).values({ id: operation.id, userId, kind: operation.kind,
          revision: 1, fields: operation.fields,
          provenance: trustedProvenance[operation.id] ?? direct(operation.fields.originalNarrative) }).returning();
        remember("record", operation.id, null, row, 1);
        break;
      }
      case "edit_record": {
        const prior = await ownedRecord(tx, userId, operation.id);
        if (prior.revision !== operation.expectedRevision) throw new CareerWriteConflict();
        const [row] = await tx.update(careerRecords).set({ fields: operation.fields, revision: prior.revision + 1, updatedAt: new Date() })
          .where(eq(careerRecords.id, operation.id)).returning();
        remember("record", operation.id, prior, row, row!.revision);
        if (prior.provenance.kind !== "direct_user" &&
            prior.fields.originalNarrative !== operation.fields.originalNarrative) {
          const narrativeId = legacyCareerId(userId, "authored_narrative", operation.id);
          const [previousNarrative] = await tx.select().from(careerAssertions)
            .where(and(eq(careerAssertions.userId, userId), eq(careerAssertions.id, narrativeId))).limit(1);
          if (previousNarrative) {
            const [nextNarrative] = await tx.update(careerAssertions).set({
              text: operation.fields.originalNarrative || previousNarrative.text,
              status: operation.fields.originalNarrative ? "usable" : "retracted",
              revision: previousNarrative.revision + 1, updatedAt: new Date(),
            }).where(eq(careerAssertions.id, narrativeId)).returning();
            remember("assertion", narrativeId, previousNarrative, nextNarrative, nextNarrative!.revision);
          } else if (operation.fields.originalNarrative) {
            const [nextNarrative] = await tx.insert(careerAssertions).values({ id: narrativeId,
              userId, subjectId: operation.id, revision: 1, text: operation.fields.originalNarrative,
              publicText: null, facets: [], context: null, status: "usable",
              provenance: direct(operation.fields.originalNarrative) }).returning();
            remember("assertion", narrativeId, null, nextNarrative, 1);
          }
        }
        break;
      }
      case "archive_record": {
        const prior = await ownedRecord(tx, userId, operation.id);
        if (prior.revision !== operation.expectedRevision) throw new CareerWriteConflict();
        const [row] = await tx.update(careerRecords).set({ archivedAt: operation.archived ? new Date() : null,
          revision: prior.revision + 1, updatedAt: new Date() }).where(eq(careerRecords.id, operation.id)).returning();
        remember("record", operation.id, prior, row, row!.revision);
        break;
      }
      case "create_link": {
        if (operation.fromId === operation.toId) throw new CareerWriteConflict("A relationship needs two different items.");
        const from = await ownedRecord(tx, userId, operation.fromId);
        const to = await ownedRecord(tx, userId, operation.toId);
        if (from.archivedAt || to.archivedAt) throw new CareerWriteConflict("Restore both items before linking them.");
        if (operation.kind === "part_of") await assertNoPartOfCycle(tx, userId, operation.fromId, operation.toId);
        const [row] = await tx.insert(careerLinks).values({ ...operation, id: operation.id, userId, revision: 1 }).returning();
        remember("link", operation.id, null, row, 1);
        break;
      }
      case "remove_link": {
        const prior = await ownedLink(tx, userId, operation.id);
        if (prior.revision !== operation.expectedRevision) throw new CareerWriteConflict();
        const [row] = await tx.update(careerLinks).set({ archivedAt: new Date(), revision: prior.revision + 1, updatedAt: new Date() })
          .where(eq(careerLinks.id, operation.id)).returning();
        remember("link", operation.id, prior, row, row!.revision);
        break;
      }
      case "add_assertion": {
        const subject = await ownedRecord(tx, userId, operation.subjectId);
        if (subject.archivedAt) throw new CareerWriteConflict("Restore this item before adding facts.");
        const provenance = trustedProvenance[operation.id] ?? direct(operation.text);
        const status = provenance.kind === "model" ? "proposed" as const : "usable" as const;
        const [row] = await tx.insert(careerAssertions).values({ id: operation.id, userId, subjectId: operation.subjectId,
          revision: 1, text: operation.text, publicText: operation.publicText, facets: operation.facets, context: operation.context,
          provenance, status }).returning();
        remember("assertion", operation.id, null, row, 1);
        break;
      }
      case "edit_assertion": {
        const prior = await ownedAssertion(tx, userId, operation.id);
        if (prior.revision !== operation.expectedRevision) throw new CareerWriteConflict();
        const [row] = await tx.update(careerAssertions).set({ text: operation.text, ...(operation.publicText !== undefined ? { publicText: operation.publicText } : {}), facets: operation.facets,
          context: operation.context, revision: prior.revision + 1, updatedAt: new Date() })
          .where(eq(careerAssertions.id, operation.id)).returning();
        remember("assertion", operation.id, prior, row, row!.revision);
        break;
      }
      case "retract_assertion": {
        const prior = await ownedAssertion(tx, userId, operation.id);
        if (prior.revision !== operation.expectedRevision) throw new CareerWriteConflict();
        const [row] = await tx.update(careerAssertions).set({ status: operation.retracted ? "retracted"
          : prior.provenance.kind === "model" ? "proposed" : "usable",
          revision: prior.revision + 1, updatedAt: new Date() }).where(eq(careerAssertions.id, operation.id)).returning();
        remember("assertion", operation.id, prior, row, row!.revision);
        break;
      }
      case "save_perspective": {
        for (const id of operation.assertionIds) {
          const assertion = await ownedAssertion(tx, userId, id);
          if (assertion.status !== "usable") throw new CareerWriteConflict("A perspective can use saved facts only.");
        }
        if (operation.expectedRevision === 0) {
          const [row] = await tx.insert(careerPerspectives).values({ id: operation.id, userId, revision: 1,
            label: operation.label, note: operation.note, assertionIds: operation.assertionIds }).returning();
          remember("perspective", operation.id, null, row, 1);
        } else {
          const prior = await ownedPerspective(tx, userId, operation.id);
          if (prior.revision !== operation.expectedRevision) throw new CareerWriteConflict();
          const [row] = await tx.update(careerPerspectives).set({ label: operation.label, note: operation.note,
            assertionIds: operation.assertionIds, revision: prior.revision + 1, updatedAt: new Date() })
            .where(eq(careerPerspectives.id, operation.id)).returning();
          remember("perspective", operation.id, prior, row, row!.revision);
        }
        break;
      }
      case "remove_perspective": {
        const prior = await ownedPerspective(tx, userId, operation.id);
        if (prior.revision !== operation.expectedRevision) throw new CareerWriteConflict();
        const [row] = await tx.update(careerPerspectives).set({ archivedAt: new Date(), revision: prior.revision + 1,
          updatedAt: new Date() }).where(eq(careerPerspectives.id, operation.id)).returning();
        remember("perspective", operation.id, prior, row, row!.revision);
        break;
      }
    }
  }
  await tx.insert(careerChanges).values({ id: changeId, userId, revision, requestKey: input.requestKey,
    intentHash, operations: input.operations, before, after });
  for (const item of touched) await tx.insert(careerObjectVersions).values({ userId, objectKind: item.kind,
    objectId: item.id, revision: item.revision, changeId, snapshot: item.row });
  await tx.update(careerHeads).set({ revision, updatedAt: new Date() }).where(eq(careerHeads.userId, userId));
  const conflicts = await careerConflicts(tx, userId);
  return { ok: true, revision, changeId, changedIds: [...new Set(touched.map(item => item.id))], conflicts };
}

/** Publish only the current named head; a replay never replaces a newer compatibility view. */
export async function publishCareerCompatibilityIn(tx: Tx, userId: string, revision: number): Promise<number | null> {
    const latest = await latestCvLibrary(tx as unknown as Db, userId);
    const [head] = await tx.select({ revision: careerHeads.revision }).from(careerHeads)
      .where(eq(careerHeads.userId, userId)).limit(1);
    if (head?.revision !== revision || latest?.content.careerProjection?.version === revision) return null;
    const [account] = await tx.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
    if (!(latest?.content.name.trim() || account?.name?.trim())) return null;
    const presentation = latest?.content.theme?.experienceLayout ?? "chronological";
    const projected = await careerCvEvidence(tx as unknown as Db, userId, revision, {}, presentation);
    const version = (latest?.version ?? 0) + 1;
    await tx.insert(cvLibraries).values({ userId, version: (latest?.version ?? 0) + 1,
      content: projected.library });
    return version;
}

export async function saveCareerChange(db: Db, userId: string, input: CareerChange): Promise<CareerChangeResult> {
  await ensureCareerBackfill(db, userId);
  return db.transaction(async tx => {
    const result = await saveCareerChangeIn(tx, userId, input);
    if (!result.ok) return result;
    // A career fact remains durable without a name. Once named, existing readers see it in this commit.
    await publishCareerCompatibilityIn(tx, userId, result.revision);
    return result;
  });
}

/** Undo is another change; it never deletes the original entry or rewrites a past snapshot. */
export async function undoCareerChange(db: Db, userId: string, input: {
  changeId: string; expectedRevision: number; requestKey: string,
}): Promise<CareerChangeResult> {
  await ensureCareerBackfill(db, userId);
  return db.transaction(async tx => {
    const head = await headForUpdate(tx, userId);
    const intentHash = hash(input);
    const [replay] = await tx.select().from(careerChanges)
      .where(and(eq(careerChanges.userId, userId), eq(careerChanges.requestKey, input.requestKey))).limit(1);
    if (replay) {
      if (replay.intentHash !== intentHash) throw new CareerWriteConflict("This undo key was used for another change.");
      return { ok: true, revision: replay.revision, changeId: replay.id,
        changedIds: Object.keys(replay.after).map(key => key.slice(key.indexOf(":") + 1)), conflicts: [] };
    }
    if (input.expectedRevision > head.revision) throw new CareerWriteConflict();
    const [original] = await tx.select().from(careerChanges)
      .where(and(eq(careerChanges.userId, userId), eq(careerChanges.id, input.changeId))).limit(1);
    if (!original || original.undoOf) throw new CareerWriteConflict("That Experience change cannot be undone.");
    const [priorUndo] = await tx.select({ id: careerChanges.id }).from(careerChanges)
      .where(and(eq(careerChanges.userId, userId), eq(careerChanges.undoOf, original.id))).limit(1);
    if (priorUndo) throw new CareerWriteConflict("That Experience change was already undone.");
    const before: Record<string, Row | null> = {};
    const after: Record<string, Row | null> = {};
    const touched: Array<{ kind: ObjectKind; id: string; revision: number; row: Row }> = [];
    for (const key of Object.keys(original.after).reverse()) {
      const [kind, id] = key.split(":") as [ObjectKind, string];
      const expected = original.after[key] as Row | null;
      const previous = original.before[key] as Row | null;
      if (!expected) throw new CareerWriteConflict("That change has no saved result to undo.");
      let current: Row;
      let restored: Row;
      if (kind === "record") {
        const row = await ownedRecord(tx, userId, id);
        if (row.revision !== expected.revision) throw new CareerWriteConflict("This item changed after the original save. Review it before undoing.");
        if (!previous) {
          const [laterFact] = await tx.select({ id: careerAssertions.id }).from(careerAssertions)
            .where(and(eq(careerAssertions.userId, userId), eq(careerAssertions.subjectId, id),
              sql`${careerAssertions.status} <> 'retracted'`, sql`not (${careerAssertions.id}::text = any(${Object.keys(original.after).filter(key => key.startsWith("assertion:")).map(key => key.slice(10))}::text[]))`)).limit(1);
          const [laterLink] = await tx.select({ id: careerLinks.id }).from(careerLinks)
            .where(and(eq(careerLinks.userId, userId), or(eq(careerLinks.fromId, id), eq(careerLinks.toId, id)),
              sql`${careerLinks.archivedAt} is null`, sql`not (${careerLinks.id}::text = any(${Object.keys(original.after).filter(key => key.startsWith("link:")).map(key => key.slice(5))}::text[]))`)).limit(1);
          if (laterFact || laterLink) throw new CareerWriteConflict("Newer facts or relationships use this item. Review them before undoing it.");
        }
        current = snapshot(row)!;
        const [next] = await tx.update(careerRecords).set({
          ...(previous ? { fields: CareerRecordFieldsSchema.parse(previous.fields),
            archivedAt: previous.archivedAt ? new Date(String(previous.archivedAt)) : null } : { archivedAt: new Date() }),
          revision: row.revision + 1, updatedAt: new Date(),
        }).where(eq(careerRecords.id, id)).returning();
        restored = snapshot(next)!;
      } else if (kind === "link") {
        const row = await ownedLink(tx, userId, id);
        if (row.revision !== expected.revision) throw new CareerWriteConflict("This relationship changed after the original save.");
        if (previous && previous.archivedAt == null && row.kind === "part_of")
          await assertNoPartOfCycle(tx, userId, row.fromId, row.toId);
        current = snapshot(row)!;
        const [next] = await tx.update(careerLinks).set({
          ...(previous ? { confidential: Boolean(previous.confidential), publicLabel: previous.publicLabel == null ? null : String(previous.publicLabel),
            archivedAt: previous.archivedAt ? new Date(String(previous.archivedAt)) : null } : { archivedAt: new Date() }),
          revision: row.revision + 1, updatedAt: new Date(),
        }).where(eq(careerLinks.id, id)).returning();
        restored = snapshot(next)!;
      } else if (kind === "assertion") {
        const row = await ownedAssertion(tx, userId, id);
        if (row.revision !== expected.revision) throw new CareerWriteConflict("This fact changed after the original save.");
        current = snapshot(row)!;
        const [next] = await tx.update(careerAssertions).set({
          ...(previous ? { text: String(previous.text), publicText: previous.publicText == null ? null : String(previous.publicText), facets: previous.facets as string[],
            context: previous.context as typeof row.context,
            status: previous.status as typeof row.status,
            provenance: CareerProvenanceSchema.parse(previous.provenance) } : { status: "retracted" as const }),
          revision: row.revision + 1, updatedAt: new Date(),
        }).where(eq(careerAssertions.id, id)).returning();
        restored = snapshot(next)!;
      } else {
        const row = await ownedPerspective(tx, userId, id);
        if (row.revision !== expected.revision) throw new CareerWriteConflict("This perspective changed after the original save.");
        current = snapshot(row)!;
        const [next] = await tx.update(careerPerspectives).set({
          ...(previous ? { label: String(previous.label), note: String(previous.note), assertionIds: previous.assertionIds as string[],
            archivedAt: previous.archivedAt ? new Date(String(previous.archivedAt)) : null } : { archivedAt: new Date() }),
          revision: row.revision + 1, updatedAt: new Date(),
        }).where(eq(careerPerspectives.id, id)).returning();
        restored = snapshot(next)!;
      }
      before[key] = current;
      after[key] = restored;
      touched.push({ kind, id, revision: Number(restored.revision), row: restored });
    }
    const revision = head.revision + 1;
    const changeId = randomUUID();
    await tx.insert(careerChanges).values({ id: changeId, userId, revision, requestKey: input.requestKey,
      intentHash, operations: [], before, after, undoOf: original.id });
    for (const item of touched) await tx.insert(careerObjectVersions).values({ userId,
      objectKind: item.kind, objectId: item.id, revision: item.revision, changeId, snapshot: item.row });
    await tx.update(careerHeads).set({ revision, updatedAt: new Date() }).where(eq(careerHeads.userId, userId));
    await publishCareerCompatibilityIn(tx, userId, revision);
    return { ok: true, revision, changeId, changedIds: touched.map(item => item.id),
      conflicts: await careerConflicts(tx, userId) };
  });
}

/** Only same subject/attribute/scope/period with different explicit values is a conflict. */
export async function careerConflicts(db: Pick<Db, "select">, userId: string): Promise<CareerConflictView[]> {
  const assertions = await db.select({ id: careerAssertions.id, subjectId: careerAssertions.subjectId,
    context: careerAssertions.context, status: careerAssertions.status,
    provenance: careerAssertions.provenance }).from(careerAssertions)
    .innerJoin(careerRecords, and(eq(careerAssertions.subjectId, careerRecords.id), eq(careerRecords.userId, userId)))
    .where(and(eq(careerAssertions.userId, userId), eq(careerAssertions.status, "usable"),
      sql`${careerRecords.archivedAt} is null`, sql`${careerAssertions.context} is not null`));
  return careerConflictingGroups(assertions).map(({ key, rows }) => ({ id: hash(key),
    subjectId: rows[0]!.subjectId, assertionIds: rows.map(row => row.id),
    reason: "Different values were saved for the same subject, scope and period. Review both facts." }));
}

const recordView = (row: typeof careerRecords.$inferSelect): CareerRecordView => ({ id: row.id, kind: row.kind,
  revision: row.revision, fields: row.fields, provenance: row.provenance, archived: !!row.archivedAt,
  createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
const assertionView = (row: typeof careerAssertions.$inferSelect): CareerAssertionView => ({ id: row.id,
  subjectId: row.subjectId, revision: row.revision, text: row.text, publicText: row.publicText,
  facets: row.facets as CareerAssertionView["facets"], status: row.status, provenance: row.provenance,
  context: row.context ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });

export async function getCareerWorkspace(db: Db, userId: string,
  options: { recordId?: string; legacyJobId?: string; assertionId?: string; query?: string; cursor?: string; assertionsCursor?: string;
    linksCursor?: string; changesCursor?: number } = {}): Promise<CareerWorkspace> {
  await ensureCareerBackfill(db, userId);
  return db.transaction(async tx => {
  const [head] = await tx.select().from(careerHeads).where(eq(careerHeads.userId, userId)).limit(1);
  const [cursorTime, cursorId] = options.cursor?.split("|") ?? [];
  const cursor = cursorTime ? new Date(cursorTime) : null;
  if (options.cursor && (!cursor || Number.isNaN(cursor.getTime()) || !cursorId || !/^[a-f0-9-]{36}$/i.test(cursorId)))
    throw new CareerWriteConflict("The Experience page cursor is invalid.");
  const rows = await tx.select({ id: careerRecords.id, kind: careerRecords.kind, revision: careerRecords.revision,
    archivedAt: careerRecords.archivedAt, updatedAt: careerRecords.updatedAt,
    title: sql<string>`${careerRecords.fields}->>'title'`,
    dates: sql<CareerRecordView["fields"]["dates"]>`${careerRecords.fields}->'dates'`,
    publicLabel: sql<string | null>`${careerRecords.fields}->>'publicLabel'`,
    confidential: sql<boolean>`coalesce((${careerRecords.fields}->>'confidential')::boolean,false)` })
    .from(careerRecords).where(and(eq(careerRecords.userId, userId),
    options.query?.trim() ? ilike(sql<string>`${careerRecords.fields}->>'title'`, `%${options.query.trim()}%`) : undefined,
    cursor ? or(lt(careerRecords.updatedAt, cursor),
      and(eq(careerRecords.updatedAt, cursor), lt(careerRecords.id, cursorId!))) : undefined))
    .orderBy(desc(careerRecords.updatedAt), desc(careerRecords.id)).limit(31);
  const records = rows.slice(0, 30).map(row => ({ id: row.id, kind: row.kind, revision: row.revision,
    title: row.title, dates: row.dates, publicLabel: row.publicLabel,
    confidential: row.confidential, archived: !!row.archivedAt, updatedAt: row.updatedAt.toISOString() }));
  const skillSubjects = await tx.select({ id: careerRecords.id, archivedAt: careerRecords.archivedAt,
    confidential: sql<boolean>`coalesce((${careerRecords.fields}->>'confidential')::boolean,false)`,
    provenanceKind: sql<string>`${careerRecords.provenance}->>'kind'` })
    .from(careerRecords).where(eq(careerRecords.userId, userId));
  const skillLinks = await tx.select({ fromId: careerLinks.fromId, toId: careerLinks.toId,
    kind: careerLinks.kind, confidential: careerLinks.confidential, archivedAt: careerLinks.archivedAt })
    .from(careerLinks).where(eq(careerLinks.userId, userId));
  const privateSkillSubjects = careerPrivateRecordIds(skillSubjects.map(row => ({ id: row.id,
    confidential: row.confidential })), skillLinks.map(row => ({ fromId: row.fromId, toId: row.toId,
    kind: row.kind, confidential: row.confidential, archived: !!row.archivedAt })));
  const visibleSkillSubjects = new Set(skillSubjects.filter(row => !row.archivedAt &&
    row.provenanceKind !== "model" && !privateSkillSubjects.has(row.id)).map(row => row.id));
  const skillRows = await tx.select({ subjectId: careerAssertions.subjectId, text: careerAssertions.text,
    provenanceKind: sql<string>`${careerAssertions.provenance}->>'kind'` })
    .from(careerAssertions).where(and(eq(careerAssertions.userId, userId),
      eq(careerAssertions.status, "usable"), sql`${careerAssertions.facets} ? 'skill'`));
  const skillChoices = [...new Map(skillRows.filter(row => visibleSkillSubjects.has(row.subjectId) &&
    row.provenanceKind !== "model" && row.text.trim().length <= 120)
    .map(row => [row.text.trim().toLocaleLowerCase("en-GB"), row.text.trim()] as const)).values()]
    .sort((a, b) => a.localeCompare(b, "en-GB"));
  // Start in work rather than an organisation created alongside that work.
  const [defaultWork] = options.recordId ? [] : await tx.select({ id: careerRecords.id }).from(careerRecords)
    .where(and(eq(careerRecords.userId, userId), isNull(careerRecords.archivedAt),
      options.query?.trim() ? ilike(sql<string>`${careerRecords.fields}->>'title'`, `%${options.query.trim()}%`) : undefined,
      inArray(careerRecords.kind, ["role", "engagement", "project", "contribution"])))
    .orderBy(desc(careerRecords.updatedAt), desc(careerRecords.id)).limit(1);
  const chosenId = options.recordId ?? (options.legacyJobId
    ? legacyCareerId(userId, "role", options.legacyJobId) : null) ?? defaultWork?.id ?? rows[0]?.id;
  const chosen = chosenId ? (await tx.select().from(careerRecords)
    .where(and(eq(careerRecords.userId, userId), eq(careerRecords.id, chosenId))).limit(1))[0] : null;
  const privacy = chosen ? await tx.execute<{ hidden: boolean }>(sql`
    with recursive lineage(id) as (
      select ${chosen.id}::uuid
      union
      select l.to_id from career_links l join lineage a on a.id = l.from_id
      where l.user_id = ${userId}::uuid and l.archived_at is null
        and l.kind in ('part_of','contributed_to','employed_by','contracted_through','delivered_for')
    )
    select exists (
      select 1 from lineage a join career_records r on r.id = a.id and r.user_id = ${userId}::uuid
      where coalesce((r.fields->>'confidential')::boolean,false)
      union all
      select 1 from lineage a join career_links l on l.from_id = a.id and l.user_id = ${userId}::uuid
      where l.archived_at is null and l.confidential
    ) as hidden`) : null;
  const requestedAssertion = chosen && options.assertionId ? (await tx.select().from(careerAssertions)
    .where(and(eq(careerAssertions.userId, userId), eq(careerAssertions.subjectId, chosen.id),
      eq(careerAssertions.id, options.assertionId))).limit(1))[0] : null;
  const allAssertionIds = chosen ? await tx.select({ id: careerAssertions.id }).from(careerAssertions)
    .where(and(eq(careerAssertions.userId, userId), eq(careerAssertions.subjectId, chosen.id))) : [];
  const allLinkIds = chosen ? await tx.select({ id: careerLinks.id }).from(careerLinks)
    .where(and(eq(careerLinks.userId, userId), or(eq(careerLinks.fromId, chosen.id), eq(careerLinks.toId, chosen.id)))) : [];
  const selectedAssertions = chosen ? await tx.select().from(careerAssertions).where(and(eq(careerAssertions.userId, userId),
    eq(careerAssertions.subjectId, chosen.id), options.assertionsCursor ? lt(careerAssertions.id, options.assertionsCursor) : undefined))
    .orderBy(desc(careerAssertions.id)).limit(31) : [];
  const selectedLinks = chosen ? await tx.select().from(careerLinks).where(and(eq(careerLinks.userId, userId),
    or(eq(careerLinks.fromId, chosen.id), eq(careerLinks.toId, chosen.id)),
    options.linksCursor ? lt(careerLinks.id, options.linksCursor) : undefined))
    .orderBy(desc(careerLinks.id)).limit(31) : [];
  const otherIds = selectedLinks.map(row => row.fromId === chosen?.id ? row.toId : row.fromId);
  const otherRows = otherIds.length ? await tx.select({ id: careerRecords.id,
    title: sql<string>`${careerRecords.fields}->>'title'` }).from(careerRecords)
    .where(and(eq(careerRecords.userId, userId), inArray(careerRecords.id, otherIds))) : [];
  const otherTitles = new Map(otherRows.map(row => [row.id, row.title]));
  const relatedKeys = chosen ? [`record:${chosen.id}`,
    ...allAssertionIds.map(row => `assertion:${row.id}`), ...allLinkIds.map(row => `link:${row.id}`)] : [];
  const selectedChanges = chosen ? await tx.select().from(careerChanges).where(and(eq(careerChanges.userId, userId),
    options.changesCursor ? lt(careerChanges.revision, options.changesCursor) : undefined,
    sql`${careerChanges.after} ?| ARRAY[${sql.join(relatedKeys.map(key => sql`${key}`), sql`, `)}]::text[]`))
    .orderBy(desc(careerChanges.revision)).limit(31) : [];
  const selected = chosen ? {
    record: recordView(chosen),
    effectiveConfidential: privacy?.rows[0]?.hidden ?? false,
    assertions: [...selectedAssertions.slice(0, 30),
      ...(requestedAssertion && !selectedAssertions.slice(0, 30).some(row => row.id === requestedAssertion.id)
        ? [requestedAssertion] : [])].map(assertionView),
    links: selectedLinks.slice(0, 30).map(row => ({ id: row.id,
      fromId: row.fromId, toId: row.toId, kind: row.kind, revision: row.revision,
      confidential: row.confidential, publicLabel: row.publicLabel,
      otherTitle: otherTitles.get(row.fromId === chosen.id ? row.toId : row.fromId) ?? "Unspecified item",
      archived: !!row.archivedAt })),
    perspectives: (await tx.select().from(careerPerspectives).where(eq(careerPerspectives.userId, userId)))
      .filter(row => !row.archivedAt && row.assertionIds.some(id => allAssertionIds.some(assertion => assertion.id === id)))
      .map(row => ({ id: row.id, revision: row.revision, label: row.label, note: row.note,
        assertionIds: row.assertionIds, archived: !!row.archivedAt })),
    changes: selectedChanges.slice(0, 30)
      .map(row => ({ id: row.id, revision: row.revision,
        changedIds: Object.keys(row.after).map(key => key.slice(key.indexOf(":") + 1)),
        undoOf: row.undoOf, createdAt: row.createdAt.toISOString() })),
    assertionsNextCursor: selectedAssertions.length > 30 ? selectedAssertions[29]!.id : null,
    linksNextCursor: selectedLinks.length > 30 ? selectedLinks[29]!.id : null,
    changesNextCursor: selectedChanges.length > 30 ? selectedChanges[29]!.revision : null,
  } : null;
  return { revision: head?.revision ?? 0, records, skillChoices,
    nextCursor: rows.length > 30 ? `${rows[29]!.updatedAt.toISOString()}|${rows[29]!.id}` : null,
    selected, conflicts: await careerConflicts(tx, userId) };
  }, { isolationLevel: "repeatable read" });
}
