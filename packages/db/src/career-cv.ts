import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { careerConflictingGroups, careerPrivateRecordIds, CareerRecordFieldsSchema, CareerProvenanceSchema, type CareerAssertionContext,
  careerCanonicalJson, type CareerCvChoiceOverride, type CareerCvProjection,
  type CareerDisplayEntry, type CareerPresentation, type CareerSourceMap } from "@col/core/career-record";
import { careerConflictFingerprint } from "@col/core/career-conflicts";
import { CvLibrarySchema, responsibilityRows, type CvLibrary } from "@col/core/cv";
import type { Db } from "./client";
import { ensureCareerBackfill } from "./career-backfill";
import { latestCvLibrary } from "./cv-library";
import { careerHeads, careerReviewEvents, users } from "./schema";

type Stored = { object_kind: "record" | "link" | "assertion" | "perspective"; object_id: string;
  snapshot: Record<string, unknown> };
type RecordRow = { id: string; kind: CareerDisplayEntry["kind"] | "organisation"; revision: number;
  fields: ReturnType<typeof CareerRecordFieldsSchema.parse>; provenance: ReturnType<typeof CareerProvenanceSchema.parse>;
  archivedAt: string | null };
type LinkRow = { id: string; fromId: string; toId: string; kind: string; confidential: boolean;
  publicLabel: string | null; archivedAt: string | null };
type AssertionRow = { id: string; subjectId: string; revision: number; text: string; publicText: string | null;
  status: "usable" | "proposed" | "retracted"; provenance: ReturnType<typeof CareerProvenanceSchema.parse>;
  facets: string[]; context: CareerAssertionContext; createdAt: string };
type PerspectiveRow = { label: string; assertionIds: string[]; archivedAt: string | null };
type Selection = { recordIds?: string[]; assertionIds?: string[]; roleText?: string; priorityTerms?: string[];
  conflictChoices?: CareerCvChoiceOverride[] };

export class CareerCvChoiceError extends Error {
  readonly userFacing = true as const;
  constructor() { super("These Experience choices changed. Review them before updating the CV."); }
}

const flattened = (value: string) => value.replace(/\s+/g, " ").trim();
const cvAssertionText = (row: AssertionRow, confidential: boolean, qualifyContext = true): string | null => {
  if (confidential) return row.publicText ? flattened(row.publicText) : null;
  const body = flattened(row.text);
  if (!row.context || !qualifyContext) return body;
  const { attribute, value, scope, period } = row.context;
  return `${body} [${attribute}: ${value}; ${scope}${period ? `; ${period}` : ""}]`;
};
const terms = (value: string) => [...new Set((value.toLocaleLowerCase("en-GB").match(/[\p{L}\p{N}]{3,}/gu) ?? []))];
const relevance = (value: string, role: Set<string>, priorities: Set<string>) => {
  const words = new Set(terms(value));
  return [...words].reduce((sum, word) => sum + (priorities.has(word) ? 4 : 0) + (role.has(word) ? 1 : 0), 0);
};
const candidateCompany = (record: RecordRow, records: Map<string, RecordRow>, links: LinkRow[]) => {
  const affiliations = links.filter(link => link.fromId === record.id && link.archivedAt === null &&
    ["employed_by", "contracted_through", "delivered_for"].includes(link.kind));
  const publicAffiliations = affiliations.filter(link => !link.confidential && !records.get(link.toId)?.fields.confidential);
  const primary = publicAffiliations.find(link => link.kind === "employed_by")
    ?? publicAffiliations.find(link => link.kind === "contracted_through")
    ?? publicAffiliations.find(link => link.kind === "delivered_for");
  if (primary) return records.get(primary.toId)?.fields.title ?? null;
  const labelled = affiliations.find(link => link.confidential && link.publicLabel);
  return labelled?.publicLabel ?? null;
};
const candidateIndustries = (record: RecordRow, records: Map<string, RecordRow>, links: LinkRow[]) => {
  if (record.fields.industries.length) return record.fields.industries;
  const linked = links.find(link => link.fromId === record.id && !link.archivedAt && !link.confidential &&
    ["employed_by", "contracted_through", "delivered_for"].includes(link.kind) &&
    !records.get(link.toId)?.fields.confidential);
  return linked ? records.get(linked.toId)?.fields.industries ?? [] : [];
};

/** Reconstruct exactly the object versions known to one account at the requested head revision. */
async function careerSnapshot(db: Db, userId: string, version: number): Promise<Stored[]> {
  const result = await db.execute<Stored>(sql`select distinct on (v.object_kind, v.object_id)
    v.object_kind, v.object_id, v.snapshot
    from career_object_versions v join career_changes c on c.id = v.change_id
    where v.user_id = ${userId}::uuid and c.revision <= ${version}
    order by v.object_kind, v.object_id, c.revision desc, v.revision desc`);
  return result.rows;
}

/** A CV-sized, immutable view. Capacity exclusions are returned, never applied to career storage. */
export async function careerCvEvidence(db: Db, userId: string, careerVersion: number,
  selection: Selection = {}, presentation: CareerPresentation = "chronological"): Promise<CareerCvProjection> {
  await ensureCareerBackfill(db, userId);
  return db.transaction(async tx => {
    const [head] = await tx.select().from(careerHeads).where(eq(careerHeads.userId, userId)).limit(1);
    if (!head || !Number.isInteger(careerVersion) || careerVersion < 0 || careerVersion > head.revision)
      throw new Error("That Experience version is unavailable.");
    const base = await latestCvLibrary(tx as unknown as Db, userId);
    const account = await tx.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
    const snapshot = await careerSnapshot(tx as unknown as Db, userId, careerVersion);
    const name = base?.content.name.trim() || account[0]?.name?.trim();
    if (!name) throw new Error("Add your name to Experience before building a CV.");
    const records = snapshot.filter(row => row.object_kind === "record").map(row => {
      const value = row.snapshot;
      return { id: String(value.id), kind: value.kind as RecordRow["kind"], revision: Number(value.revision),
        fields: CareerRecordFieldsSchema.parse(value.fields), provenance: CareerProvenanceSchema.parse(value.provenance),
        archivedAt: value.archivedAt ? String(value.archivedAt) : null } satisfies RecordRow;
    });
    const links = snapshot.filter(row => row.object_kind === "link").map(row => row.snapshot as LinkRow);
    const assertions = snapshot.filter(row => row.object_kind === "assertion").map(row => {
      const value = row.snapshot;
      return { id: String(value.id), subjectId: String(value.subjectId), revision: Number(value.revision),
        text: String(value.text), publicText: value.publicText == null ? null : String(value.publicText),
        status: value.status as AssertionRow["status"], provenance: CareerProvenanceSchema.parse(value.provenance),
        facets: Array.isArray(value.facets) ? value.facets.map(String) : [],
        context: value.context as CareerAssertionContext ?? null,
        createdAt: String(value.createdAt ?? "") } satisfies AssertionRow;
    });
    const perspectives = snapshot.filter(row => row.object_kind === "perspective")
      .map(row => row.snapshot as PerspectiveRow).filter(row => !row.archivedAt);
    const byId = new Map(records.map(record => [record.id, record]));
    const privateIds = careerPrivateRecordIds(records.map(record => ({ id: record.id,
      confidential: record.fields.confidential })), links.map(link => ({ fromId: link.fromId,
      toId: link.toId, kind: link.kind, confidential: link.confidential, archived: !!link.archivedAt })));
    const wantedRecords = selection.recordIds ? new Set(selection.recordIds) : null;
    const wantedAssertions = selection.assertionIds ? new Set(selection.assertionIds) : null;
    const canonicalChoices = [...(selection.conflictChoices ?? [])].sort((a, b) => a.groupKey.localeCompare(b.groupKey));
    const requestedChoices = new Map(canonicalChoices.map(choice => [choice.groupKey, choice]));
    if (requestedChoices.size !== (selection.conflictChoices?.length ?? 0) || requestedChoices.size > 100)
      throw new CareerCvChoiceError();
    const chosenEvents = await tx.execute<{ group_key: string; fingerprint: string; choice: string;
      selected_assertion_id: string | null }>(sql`select distinct on (group_key)
      group_key, fingerprint, choice, selected_assertion_id from career_review_events
      where user_id = ${userId}::uuid and career_version <= ${careerVersion}
      order by group_key, career_version desc, decision_revision desc`);
    const decisions = new Map(chosenEvents.rows.map(row => [row.group_key, row]));
    const roleTerms = new Set(terms(selection.roleText ?? ""));
    const priorityTerms = new Set((selection.priorityTerms ?? []).flatMap(terms));
    if (wantedRecords?.size && [...wantedRecords].some(id => !byId.has(id))) throw new Error("CV selection contains an unknown Experience item.");
    if (wantedAssertions?.size && [...wantedAssertions].some(id => !assertions.some(row => row.id === id)))
      throw new Error("CV selection contains an unknown Experience fact.");
    // Resolve explicit structured conflicts against this historical snapshot, not today's mutable rows.
    const unresolved = new Set<string>();
    const reviewConflicts: CareerCvProjection["reviewConflicts"] = [];
    for (const { key, rows: group } of careerConflictingGroups(assertions.filter(row => !byId.get(row.subjectId)?.archivedAt))) {
      const fingerprint = careerConflictFingerprint(key, group);
      const override = requestedChoices.get(key);
      if (override && (override.fingerprint !== fingerprint || !group.some(row => row.id === override.chosenAssertionId)))
        throw new CareerCvChoiceError();
      requestedChoices.delete(key);
      const global = decisions.get(key);
      const validGlobal = global?.fingerprint === fingerprint ? global : null;
      const chosen = override?.chosenAssertionId ??
        (validGlobal?.choice === "choose" ? validGlobal.selected_assertion_id : null) ??
        (group.filter(row => wantedAssertions?.has(row.id)).length === 1
          ? group.find(row => wantedAssertions?.has(row.id))?.id : null);
      if (chosen) {
        for (const row of group) if (row.id !== chosen) unresolved.add(row.id);
      } else if (validGlobal?.choice !== "dismiss") {
        for (const row of group) unresolved.add(row.id);
      }
      const record = byId.get(group[0]!.subjectId);
      const privateRecord = privateIds.has(group[0]!.subjectId);
      if (record && (!wantedRecords || wantedRecords.has(record.id)) &&
        (!privateRecord || (record.fields.publicLabel && group.some(row => row.publicText))) &&
        (!validGlobal || !["choose", "dismiss"].includes(validGlobal.choice) || override)) {
        if (reviewConflicts.length >= 100) continue;
        reviewConflicts.push({ conflictId: createHash("sha256").update(careerCanonicalJson(key)).digest("hex"),
          groupKey: key, fingerprint, recordId: record.id,
          title: privateRecord ? record.fields.publicLabel! : record.fields.title,
          statements: group.filter(row => !privateRecord || row.publicText)
            .map(row => ({ id: row.id, text: privateRecord ? row.publicText! : row.text })) });
      }
    }
    if (requestedChoices.size) throw new CareerCvChoiceError();
    const perspectiveBoost = new Map<string, number>();
    if (roleTerms.size || priorityTerms.size) for (const perspective of perspectives) {
      const score = relevance(perspective.label, roleTerms, priorityTerms);
      if (!score) continue;
      for (const id of perspective.assertionIds) perspectiveBoost.set(id,
        Math.max(perspectiveBoost.get(id) ?? 0, score));
    }
    const usable = (row: AssertionRow) => row.status === "usable" && row.provenance.kind !== "model"
      && !unresolved.has(row.id) && (!wantedAssertions || wantedAssertions.has(row.id));
    const ordered = records.filter(record => record.kind !== "organisation" && !record.archivedAt &&
      (!wantedRecords || wantedRecords.has(record.id)))
      .sort((a, b) => {
        const hasFacts = (record: RecordRow) => assertions.some(item => item.subjectId === record.id && usable(item)) ||
          (record.provenance.kind === "direct_user" && !!record.fields.originalNarrative.trim());
        const rank = (row: RecordRow) => presentation === "project"
          ? Number(row.kind !== "project") : Number(row.kind === "project");
        const score = (record: RecordRow) => relevance([record.fields.title,
          ...assertions.filter(item => item.subjectId === record.id && usable(item))
            .map(item => item.publicText ?? item.text)].join(" "), roleTerms, priorityTerms);
        const boost = (record: RecordRow) => assertions.filter(item => item.subjectId === record.id && usable(item))
          .reduce((sum, item) => sum + (perspectiveBoost.get(item.id) ?? 0), 0);
        return Number(hasFacts(b)) - Number(hasFacts(a)) || score(b) + boost(b) - score(a) - boost(a) || rank(a) - rank(b)
          || (b.fields.dates.start ?? "").localeCompare(a.fields.dates.start ?? "") || a.id.localeCompare(b.id);
      });
    const employment: NonNullable<CvLibrary["employment"]> = [];
    const entries: CvLibrary["entries"] = [];
    const sourceMap: CareerSourceMap = {};
    const display: Record<string, CareerDisplayEntry> = {};
    const excluded: CareerCvProjection["excluded"] = [];
    for (const record of ordered) {
      const confidential = privateIds.has(record.id);
      const title = confidential ? record.fields.publicLabel : record.fields.title;
      if (!title || record.provenance.kind === "model") {
        excluded.push({ recordId: record.id, reason: confidential ? "confidential" : "ineligible" });
        continue;
      }
      if (entries.length >= 100 || (employment.length >= 100 &&
        ["role", "engagement", "project", "contribution"].includes(record.kind))) {
        excluded.push({ recordId: record.id, reason: "capacity" }); continue;
      }
      for (const row of assertions) if (row.subjectId === record.id && unresolved.has(row.id))
        excluded.push({ recordId: record.id, assertionId: row.id, reason: "conflict" });
      const available = assertions.filter(row => row.subjectId === record.id && usable(row));
      const disputedText = new Set(assertions.filter(row => row.subjectId === record.id && unresolved.has(row.id))
        .flatMap(row => [row.text, row.publicText].filter((text): text is string => !!text).map(flattened)));
      const hasSkillLabels = record.kind === "skill" && available.some(row => row.facets.includes("skill"));
      const labelEvidence = hasSkillLabels ? available.filter(row => row.facets.includes("skill")) : available;
      const rows: Array<{ text: string; assertion: AssertionRow | null }> = [];
      if (!confidential && record.provenance.kind === "direct_user" &&
        (record.kind !== "skill" || labelEvidence.length === 0)) {
        for (const line of responsibilityRows(record.fields.originalNarrative))
          if (line && !disputedText.has(flattened(line)) &&
            !available.some(item => flattened(item.text) === flattened(line))) rows.push({ text: line, assertion: null });
      }
      for (const assertion of labelEvidence) {
        const text = cvAssertionText(assertion, confidential, record.kind !== "skill");
        if (text) rows.push({ text: flattened(text), assertion });
        else if (confidential) excluded.push({ recordId: record.id, assertionId: assertion.id, reason: "confidential" });
      }
      if (!rows.length) {
        // Keep an empty saved Work destination available for the first user-authored fact.
        if (["role", "engagement", "project", "contribution"].includes(record.kind)) {
          const company = candidateCompany(record, byId, links) ?? "Organisation not specified";
          employment.push({ id: record.id, company, jobTitle: title,
            startDate: record.fields.dates.start ?? "", endDate: record.fields.dates.end ?? "",
            current: record.fields.dates.current });
          display[record.id] = { recordId: record.id, kind: record.kind as CareerDisplayEntry["kind"],
            title, organisationLabel: company, dates: record.fields.dates,
            publicLabel: record.fields.publicLabel, groupRecordId: null };
        }
        excluded.push({ recordId: record.id, reason: confidential ? "confidential" : "ineligible" });
        continue;
      }
      const skillOrder = (row: typeof rows[number]) => {
        const provenance = row.assertion?.provenance;
        const source = `${provenance?.captureContext ?? ""} ${provenance?.sourceId ?? ""}`;
        const match = source.match(/(?:row|skill):(\d+)(?!.*(?:row|skill):\d+)/);
        return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
      };
      const rankedRows = rows.map((row, index) => ({ ...row, index })).sort((a, b) =>
        record.kind === "skill"
          ? skillOrder(a) - skillOrder(b) || (a.assertion?.createdAt ?? "").localeCompare(b.assertion?.createdAt ?? "") || a.index - b.index
          : relevance(b.text, roleTerms, priorityTerms) + (b.assertion ? perspectiveBoost.get(b.assertion.id) ?? 0 : 0)
            - relevance(a.text, roleTerms, priorityTerms) - (a.assertion ? perspectiveBoost.get(a.assertion.id) ?? 0 : 0)
            || a.index - b.index);
      const selected: typeof rankedRows = [];
      let selectedCharacters = 0;
      for (const row of rankedRows.slice(0, 20)) {
        const fits = record.kind === "skill" ? row.text.length <= 150
          : selectedCharacters + row.text.length + (selected.length ? 1 : 0) <= 40_000;
        if (!fits) {
          excluded.push({ recordId: record.id,
            ...(row.assertion ? { assertionId: row.assertion.id } : {}), reason: "capacity" });
          continue;
        }
        selectedCharacters += row.text.length + (selected.length ? 1 : 0);
        selected.push(row);
      }
      for (const row of rankedRows.slice(20)) excluded.push({ recordId: record.id,
        ...(row.assertion ? { assertionId: row.assertion.id } : {}), reason: "capacity" });
      if (!selected.length) {
        excluded.push({ recordId: record.id, reason: "capacity" });
        continue;
      }
      const company = candidateCompany(record, byId, links) ?? "Organisation not specified";
      const experience = ["role", "engagement", "project", "contribution"].includes(record.kind);
      if (experience) employment.push({ id: record.id, company, jobTitle: title,
        ...(!confidential && candidateIndustries(record, byId, links).length
          ? { industryDescriptions: candidateIndustries(record, byId, links).join(", ") } : {}),
        startDate: record.fields.dates.start ?? "", endDate: record.fields.dates.end ?? "",
        current: record.fields.dates.current });
      const kind: CvLibrary["entries"][number]["kind"] = experience ? "experience"
        : record.kind === "qualification" ? "education" : record.kind === "learning" ? "training"
          : record.kind === "skill" ? "skill" : "interest";
      const supportTexts = kind === "skill" ? available.filter(row => !row.facets.includes("skill"))
        .map(row => cvAssertionText(row, confidential)).filter((text): text is string => !!text) : [];
      const skillNarrativeRows = kind === "skill"
        ? [...new Set([...(confidential ? [] : responsibilityRows(record.fields.originalNarrative)),
          ...supportTexts.map(flattened)].filter(text => !disputedText.has(flattened(text))))] : [];
      const boundedNarrative: string[] = [];
      let narrativeCharacters = 0;
      for (const text of skillNarrativeRows) {
        if (narrativeCharacters + text.length + (boundedNarrative.length ? 1 : 0) > 40_000) {
          const source = available.find(row => !row.facets.includes("skill") &&
            flattened(cvAssertionText(row, confidential) ?? "") === flattened(text));
          excluded.push({ recordId: record.id, ...(source ? { assertionId: source.id } : {}), reason: "capacity" });
          continue;
        }
        narrativeCharacters += text.length + (boundedNarrative.length ? 1 : 0);
        boundedNarrative.push(text);
      }
      const skillNarrative = boundedNarrative.join("\n") || null;
      entries.push({ id: record.id, kind, heading: title,
        details: skillNarrative ?? selected.map(row => row.text).join("\n"),
        ...(experience ? { employmentId: record.id, confirmedResponsibilities: selected.map(row => row.text) } : {}),
        ...(kind === "skill" ? { skillItems: selected.map(row => row.text) } : {}) });
      for (const [index, row] of selected.entries()) {
        const ref = { recordId: record.id, recordRevision: record.revision,
          assertionId: row.assertion?.id ?? null, assertionRevision: row.assertion?.revision ?? null,
          publicText: confidential,
          ...(row.assertion?.provenance.kind === "accepted_suggestion" ||
            (!row.assertion && record.provenance.kind === "accepted_suggestion")
            ? { origin: "accepted_suggestion" as const } : {}) };
        if (!skillNarrative) sourceMap[`entry:${record.id}:row:${index}`] = ref;
        if (kind === "skill") sourceMap[`entry:${record.id}:skill:${index}`] = ref;
      }
      if (skillNarrative) for (const [index, text] of responsibilityRows(skillNarrative).entries()) {
        const cited = available.find(row => !row.facets.includes("skill") &&
          flattened(cvAssertionText(row, confidential) ?? "") === flattened(text));
        sourceMap[`entry:${record.id}:row:${index}`] = { recordId: record.id,
          recordRevision: record.revision, assertionId: cited?.id ?? null,
          assertionRevision: cited?.revision ?? null, publicText: confidential,
          ...(cited?.provenance.kind === "accepted_suggestion" ||
            (!cited && record.provenance.kind === "accepted_suggestion")
            ? { origin: "accepted_suggestion" as const } : {}) };
      }
      const parents = links.filter(link => link.fromId === record.id && link.kind === "part_of" && !link.archivedAt);
      display[record.id] = { recordId: record.id, kind: record.kind as CareerDisplayEntry["kind"], title,
        organisationLabel: company, dates: record.fields.dates, publicLabel: record.fields.publicLabel,
        groupRecordId: parents.length === 1 ? parents[0]!.toId : null };
    }
    const library = CvLibrarySchema.parse({ name, contact: base?.content.contact ?? "",
      email: base?.content.email, phone: base?.content.phone, location: base?.content.location,
      linkedinUrl: base?.content.linkedinUrl, websiteUrl: base?.content.websiteUrl,
      profile: privateIds.size > 0
        ? "" : base?.content.profile ?? "",
      stylePreferences: base?.content.stylePreferences,
      preferredWording: base?.content.preferredWording,
      facetedRows: base?.content.facetedRows,
      theme: base?.content.theme, structuredExperience: true, employment, entries,
      careerProjection: { version: careerVersion, presentation, display, sourceMap,
        ...(canonicalChoices.length ? { conflictChoices: canonicalChoices } : {}) } });
    return { careerVersion, presentation, library, sourceMap, display, excluded, reviewConflicts };
  }, { isolationLevel: "repeatable read" });
}

/** Select the current career head once, then retain that exact version in the CV snapshot. */
export async function latestCareerCvEvidence(db: Db, userId: string,
  selection: Selection = {}, presentation?: CareerPresentation) {
  await ensureCareerBackfill(db, userId);
  const [head] = await db.select({ revision: careerHeads.revision }).from(careerHeads)
    .where(eq(careerHeads.userId, userId)).limit(1);
  if (!head) throw new Error("Experience is unavailable.");
  const base = await latestCvLibrary(db, userId);
  return careerCvEvidence(db, userId, head.revision, selection,
    presentation ?? base?.content.theme?.experienceLayout ?? "chronological");
}
