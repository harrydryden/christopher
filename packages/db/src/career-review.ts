import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { careerCanonicalJson, careerConflictingGroups, CareerConflictDecisionInputSchema,
  type CareerConflictDecisionInput, type CareerConflictDecisionResult, type CareerConflictDetail,
  type CareerReviewSummary, type CareerReviewList, type CareerAssertionView } from "@col/core/career-record";
import { careerConflictFingerprint } from "@col/core/career-conflicts";
import type { Db } from "./client";
import { ensureCareerBackfill } from "./career-backfill";
import { publishCareerCompatibilityIn, saveCareerChangeIn } from "./career-record";
import { lockAccountScoreInput } from "./score-fence";
import { careerAssertions, careerChanges, careerHeads, careerRecords, careerReviewEvents } from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type GroupRow = { id: string; subjectId: string; revision: number; text: string; publicText: string | null;
  context: NonNullable<typeof careerAssertions.$inferSelect.context>; status: typeof careerAssertions.$inferSelect.status;
  provenance: typeof careerAssertions.$inferSelect.provenance; facets: string[]; createdAt: Date; updatedAt: Date };
type GroupMetaRow = Pick<GroupRow, "id" | "subjectId" | "revision" | "context" | "status"> &
  { provenance: { kind: string } };
type Group<T extends GroupMetaRow = GroupRow> = { id: string; key: string; fingerprint: string; rows: T[] };
type Event = typeof careerReviewEvents.$inferSelect;
type DecisionHead = Pick<Event, "id" | "conflictId" | "fingerprint" | "decisionRevision" | "choice" |
  "selectedAssertionId" | "careerVersion"> & { statementSnapshot?: Event["statementSnapshot"] };
const digest = (value: unknown) => createHash("sha256").update(careerCanonicalJson(value)).digest("hex");
export class CareerReviewConflict extends Error {
  readonly userFacing = true as const;
}

const grouped = <T extends GroupMetaRow>(rows: T[]): Group<T>[] =>
  careerConflictingGroups(rows).map(({ key, rows: members }) => ({ id: digest(key), key,
    fingerprint: careerConflictFingerprint(key, members), rows: members }));

async function groupsFor(db: Db, userId: string): Promise<Group[]> {
  const rows = await db.select({ id: careerAssertions.id, subjectId: careerAssertions.subjectId,
    revision: careerAssertions.revision, text: careerAssertions.text, publicText: careerAssertions.publicText,
    context: careerAssertions.context, status: careerAssertions.status, provenance: careerAssertions.provenance,
    facets: careerAssertions.facets, createdAt: careerAssertions.createdAt, updatedAt: careerAssertions.updatedAt })
    .from(careerAssertions).innerJoin(careerRecords, and(eq(careerRecords.id, careerAssertions.subjectId),
      eq(careerRecords.userId, userId))).where(and(eq(careerAssertions.userId, userId),
      eq(careerAssertions.status, "usable"), sql`${careerAssertions.context} is not null`,
      sql`${careerRecords.archivedAt} is null`));
  return grouped(rows as GroupRow[]);
}

async function compactGroupsFor(db: Db, userId: string): Promise<Group<GroupMetaRow>[]> {
  const rows = await db.select({ id: careerAssertions.id, subjectId: careerAssertions.subjectId,
    revision: careerAssertions.revision, context: careerAssertions.context,
    status: careerAssertions.status,
    provenanceKind: sql<string>`${careerAssertions.provenance}->>'kind'` })
    .from(careerAssertions).innerJoin(careerRecords, and(eq(careerRecords.id, careerAssertions.subjectId),
      eq(careerRecords.userId, userId))).where(and(eq(careerAssertions.userId, userId),
      eq(careerAssertions.status, "usable"), sql`${careerAssertions.context} is not null`,
      sql`${careerRecords.archivedAt} is null`));
  return grouped(rows.map(row => ({ ...row, context: row.context!,
    provenance: { kind: row.provenanceKind } })));
}

async function latestDecisions(db: Db, userId: string, includeSnapshot = false): Promise<Map<string, DecisionHead>> {
  const latest = await db.execute<{ id: string }>(sql`select distinct on (conflict_id) id from career_review_events
    where user_id = ${userId}::uuid order by conflict_id, decision_revision desc`);
  if (!latest.rows.length) return new Map();
  const rows = await db.select({ id: careerReviewEvents.id, conflictId: careerReviewEvents.conflictId,
    fingerprint: careerReviewEvents.fingerprint, decisionRevision: careerReviewEvents.decisionRevision,
    choice: careerReviewEvents.choice, selectedAssertionId: careerReviewEvents.selectedAssertionId,
    careerVersion: careerReviewEvents.careerVersion,
    ...(includeSnapshot ? { statementSnapshot: careerReviewEvents.statementSnapshot } : {}) })
    .from(careerReviewEvents).where(and(eq(careerReviewEvents.userId, userId),
    inArray(careerReviewEvents.id, latest.rows.map(row => row.id))));
  return new Map(rows.map(row => [row.conflictId, row]));
}

function currentDecision(group: Group<GroupMetaRow>, event: DecisionHead | undefined) {
  return event?.fingerprint === group.fingerprint ? event : null;
}
function summaryFor(groups: Group<GroupMetaRow>[], decisions: Map<string, DecisionHead>): CareerReviewSummary {
  let activeCount = 0, deferredCount = 0;
  for (const group of groups) {
    const decision = currentDecision(group, decisions.get(group.id));
    if (decision?.choice === "later") deferredCount++;
    else if (!decision || decision.choice === "reopen" || decision.choice === "correct" || decision.choice === "keep_both_context") activeCount++;
  }
  return { needsReview: activeCount > 0, activeCount, deferredCount };
}

/** Indexed compact conflict scan; no lifetime narrative or full workspace is serialised to navigation. */
export async function getCareerReviewSummary(db: Db, userId: string): Promise<CareerReviewSummary> {
  await ensureCareerBackfill(db, userId);
  return db.transaction(async tx => summaryFor(await compactGroupsFor(tx as unknown as Db, userId),
    await latestDecisions(tx as unknown as Db, userId)), { isolationLevel: "repeatable read" });
}

export async function listCareerReviewIssues(db: Db, userId: string,
  options: { status?: "active" | "deferred" | "decided"; cursor?: string } = {}): Promise<CareerReviewList> {
  await ensureCareerBackfill(db, userId);
  return db.transaction(async tx => {
    const groups = await compactGroupsFor(tx as unknown as Db, userId);
    const decisions = await latestDecisions(tx as unknown as Db, userId, true);
    const subjectIds = [...new Set(groups.map(group => group.rows[0]!.subjectId))];
    const titles = subjectIds.length ? await tx.select({ id: careerRecords.id,
      title: sql<string>`${careerRecords.fields}->>'title'` }).from(careerRecords)
      .where(and(eq(careerRecords.userId, userId), inArray(careerRecords.id, subjectIds))) : [];
    const byTitle = new Map(titles.map(row => [row.id, row.title]));
    const currentIds = new Set(groups.map(group => group.id));
    const items = groups.map(group => {
      const event = currentDecision(group, decisions.get(group.id));
      const status = event?.choice === "later" ? "deferred" as const
        : event && ["choose", "dismiss"].includes(event.choice) ? "decided" as const : "active" as const;
      return { id: group.id, subjectId: group.rows[0]!.subjectId,
        title: byTitle.get(group.rows[0]!.subjectId) ?? "Experience item", fingerprint: group.fingerprint,
        status, decisionRevision: decisions.get(group.id)?.decisionRevision ?? 0,
        choice: event?.choice ?? null, statementCount: group.rows.length };
    });
    for (const event of decisions.values()) if (!currentIds.has(event.conflictId)) {
      const snapshot = event.statementSnapshot as CareerAssertionView[] | undefined;
      items.push({ id: event.conflictId, subjectId: snapshot?.[0]?.subjectId ?? "",
        title: "Previous issue", fingerprint: event.fingerprint, status: "decided",
        decisionRevision: event.decisionRevision, choice: event.choice,
        statementCount: snapshot?.length ?? 0 });
    }
    const filtered = items.filter(item => (!options.status || item.status === options.status) &&
      (!options.cursor || item.id > options.cursor)).sort((a, b) => a.id.localeCompare(b.id));
    return { summary: summaryFor(groups, decisions), items: filtered.slice(0, 30),
      nextCursor: filtered.length > 30 ? filtered[29]!.id : null };
  }, { isolationLevel: "repeatable read" });
}

const view = (row: GroupRow): CareerAssertionView => ({ id: row.id, subjectId: row.subjectId,
  revision: row.revision, text: row.text, publicText: row.publicText, facets: row.facets as CareerAssertionView["facets"],
  context: row.context, status: row.status, provenance: row.provenance,
  createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });

export async function getCareerConflictDetail(db: Db, userId: string, conflictId: string,
  historyCursor?: number): Promise<CareerConflictDetail | null> {
  if (!/^[0-9a-f]{64}$/.test(conflictId)) return null;
  await ensureCareerBackfill(db, userId);
  return db.transaction(async tx => {
    const group = (await groupsFor(tx as unknown as Db, userId)).find(item => item.id === conflictId);
    const [latest] = await tx.select().from(careerReviewEvents).where(and(eq(careerReviewEvents.userId, userId),
      eq(careerReviewEvents.conflictId, conflictId))).orderBy(desc(careerReviewEvents.decisionRevision)).limit(1);
    const history = await tx.select().from(careerReviewEvents).where(and(eq(careerReviewEvents.userId, userId),
      eq(careerReviewEvents.conflictId, conflictId), historyCursor ? lt(careerReviewEvents.decisionRevision, historyCursor) : undefined))
      .orderBy(desc(careerReviewEvents.decisionRevision)).limit(31);
    if (!group && !latest) return null;
    const snapshot = group?.rows.map(view) ?? (latest?.statementSnapshot as CareerAssertionView[] ?? []);
    const subjectId = snapshot[0]?.subjectId ?? "";
    const [subject] = subjectId ? await tx.select({ title: sql<string>`${careerRecords.fields}->>'title'` })
      .from(careerRecords).where(and(eq(careerRecords.userId, userId), eq(careerRecords.id, subjectId))).limit(1) : [];
    const privacy = subjectId ? await tx.execute<{ hidden: boolean }>(sql`
      with recursive lineage(id) as (
        select ${subjectId}::uuid
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
    const validDecision = group && latest?.fingerprint === group.fingerprint ? latest : null;
    return { id: conflictId, groupKey: group?.key ?? latest!.groupKey,
      fingerprint: group?.fingerprint ?? latest!.fingerprint,
      subjectId, subjectTitle: subject?.title ?? "Previous Experience item", active: !!group,
      effectiveConfidential: privacy?.rows[0]?.hidden ?? false,
      statements: snapshot,
      decisionRevision: latest?.decisionRevision ?? 0,
      decision: validDecision ? { choice: validDecision.choice, selectedAssertionId: validDecision.selectedAssertionId,
        fingerprint: validDecision.fingerprint, createdAt: validDecision.createdAt.toISOString() } : null,
      history: history.slice(0, 30).map(row => ({ revision: row.decisionRevision, choice: row.choice,
        selectedAssertionId: row.selectedAssertionId, fingerprint: row.fingerprint,
        createdAt: row.createdAt.toISOString() })),
      historyNextCursor: history.length > 30 ? history[29]!.decisionRevision : null };
  }, { isolationLevel: "repeatable read" });
}

export async function decideCareerConflict(db: Db, userId: string, raw: CareerConflictDecisionInput): Promise<CareerConflictDecisionResult> {
  const input = CareerConflictDecisionInputSchema.parse(raw);
  await ensureCareerBackfill(db, userId);
  return db.transaction(async tx => {
    await lockAccountScoreInput(tx as unknown as Db, userId, "exclusive");
    const [head] = await tx.select().from(careerHeads).where(eq(careerHeads.userId, userId)).for("update").limit(1);
    if (!head) throw new Error("Experience is unavailable.");
    const intentHash = digest(input);
    const [replay] = await tx.select().from(careerReviewEvents).where(and(eq(careerReviewEvents.userId, userId),
      eq(careerReviewEvents.requestKey, input.requestKey))).limit(1);
    if (replay) {
      if (replay.intentHash !== intentHash) throw new CareerReviewConflict("This review key was used for a different decision.");
      const latest = (await latestDecisions(tx as unknown as Db, userId)).get(replay.conflictId);
      const current = (await groupsFor(tx as unknown as Db, userId)).find(group => group.id === replay.conflictId);
      if (latest?.id !== replay.id || (current && current.fingerprint !== replay.fingerprint))
        throw new CareerReviewConflict("A newer review decision is current. Reload this issue before continuing.");
      return { ok: true, decisionRevision: replay.decisionRevision, careerVersion: replay.careerVersion,
        summary: summaryFor(await compactGroupsFor(tx as unknown as Db, userId), await latestDecisions(tx as unknown as Db, userId)) };
    }
    const group = (await groupsFor(tx as unknown as Db, userId)).find(item => item.id === input.conflictId);
    if (!group || group.fingerprint !== input.expectedFingerprint) throw new CareerReviewConflict("These statements changed. Reload the review before deciding.");
    const decisions = await latestDecisions(tx as unknown as Db, userId);
    const prior = decisions.get(group.id);
    if ((prior?.decisionRevision ?? 0) !== input.expectedDecisionRevision)
      throw new CareerReviewConflict("This issue was reviewed in another tab. Reload it before deciding.");
    if (input.choice === "choose" && !group.rows.some(row => row.id === input.selectedAssertionId))
      throw new CareerReviewConflict("Choose a statement from this issue.");
    const edits = input.edits ?? [];
    for (const edit of edits) if (!group.rows.some(row => row.id === edit.id && row.revision === edit.expectedRevision))
      throw new CareerReviewConflict("A statement changed. Reload it before editing.");
    let careerVersion: number | null = null;
    if (edits.length) {
      const changed = await saveCareerChangeIn(tx, userId, { expectedRevision: head.revision,
        requestKey: `review-source:${input.requestKey}`, operations: edits.map(edit => ({
          type: "edit_assertion" as const, ...edit })) },
      Object.fromEntries(edits.map(edit => [edit.id, { kind: "direct_user" as const,
        sourceId: null, quote: null, originalText: edit.text, captureContext: "career_review" }])));
      if (!changed.ok) throw new Error(changed.error);
      careerVersion = changed.revision;
      if (input.choice === "keep_both_context" &&
        (await groupsFor(tx as unknown as Db, userId)).some(item =>
          item.rows.some(row => group.rows.some(old => old.id === row.id))))
        throw new CareerReviewConflict("The two statements still describe the same scope and period. Give each its own context.");
    } else if (["choose", "dismiss"].includes(input.choice) ||
      (["later", "reopen"].includes(input.choice) && prior?.fingerprint === group.fingerprint &&
        ["choose", "dismiss"].includes(prior.choice))) {
      careerVersion = head.revision + 1;
      const changeId = randomUUID();
      await tx.insert(careerChanges).values({ id: changeId, userId, revision: careerVersion,
        requestKey: `review-source:${input.requestKey}`, intentHash, operations: [],
        before: { [`review:${group.id}`]: prior ?? null },
        after: { [`review:${group.id}`]: { choice: input.choice, fingerprint: group.fingerprint } } });
      await tx.update(careerHeads).set({ revision: careerVersion, updatedAt: new Date() })
        .where(eq(careerHeads.userId, userId));
    }
    const [event] = await tx.insert(careerReviewEvents).values({ userId, conflictId: group.id,
      groupKey: group.key, fingerprint: group.fingerprint, decisionRevision: (prior?.decisionRevision ?? 0) + 1,
      choice: input.choice, selectedAssertionId: input.selectedAssertionId ?? null,
      statementSnapshot: group.rows.map(view), careerVersion, requestKey: input.requestKey, intentHash }).returning();
    if (careerVersion !== null) await publishCareerCompatibilityIn(tx, userId, careerVersion);
    return { ok: true, decisionRevision: event!.decisionRevision, careerVersion,
      summary: summaryFor(await compactGroupsFor(tx as unknown as Db, userId), await latestDecisions(tx as unknown as Db, userId)) };
  });
}
