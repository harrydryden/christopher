import { and, eq } from "drizzle-orm";
import { industryDescriptions, responsibilityRows, type CvLibrary } from "@col/core/cv";
import type { CareerOperation, CareerProvenance } from "@col/core/career-record";
import type { Db } from "./client";
import { legacyCareerId, ensureCareerBackfill } from "./career-backfill";
import { saveCareerChangeIn } from "./career-record";
import { careerAssertions, careerHeads, careerLinks, careerRecords } from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Origin = { kind: "direct_user" | "document"; sourceId?: string };

/** Capture newly accepted legacy rows under the same account lock and Library transaction. */
export async function captureLibraryAdditionsIn(tx: Tx, userId: string, before: CvLibrary | null,
  after: CvLibrary, libraryVersion: number, origin: Origin): Promise<void> {
  // The backfill must see the previous Library, not the version this transaction is publishing.
  await ensureCareerBackfill(tx as unknown as Db, userId);
  const knownRecords = new Set((await tx.select({ id: careerRecords.id }).from(careerRecords)
    .where(eq(careerRecords.userId, userId))).map(row => row.id));
  const knownLinks = new Set((await tx.select({ id: careerLinks.id }).from(careerLinks)
    .where(eq(careerLinks.userId, userId))).map(row => row.id));
  const knownFacts = new Set((await tx.select({ subjectId: careerAssertions.subjectId, text: careerAssertions.text })
    .from(careerAssertions).where(and(eq(careerAssertions.userId, userId), eq(careerAssertions.status, "usable"))))
    .map(row => `${row.subjectId}\0${row.text.trim().toLocaleLowerCase("en-GB")}`));
  const operations: CareerOperation[] = [];
  const provenance: Record<string, CareerProvenance> = {};
  const makeProvenance = (text: string): CareerProvenance => ({ kind: origin.kind,
    sourceId: origin.kind === "document" ? origin.sourceId ?? null : null,
    quote: origin.kind === "document" && text.length <= 4000 ? text : null,
    originalText: text, captureContext: `cv_library:${libraryVersion}` });
  const addRecord = (id: string, kind: CareerOperation & { type: "create_record" }) => {
    if (knownRecords.has(id)) return;
    operations.push(kind);
    provenance[id] = makeProvenance(kind.fields.originalNarrative || kind.fields.title);
    knownRecords.add(id);
  };
  for (const job of after.employment ?? []) {
    if (after.entries.some(entry => entry.kind === "experience" && entry.employmentId === job.id)) continue;
    const organisationId = legacyCareerId(userId, "organisation", job.id);
    const roleId = legacyCareerId(userId, "role", job.id);
    addRecord(organisationId, { type: "create_record", id: organisationId, kind: "organisation",
      fields: { title: job.company.trim() || "Organisation not specified", originalNarrative: "",
        dates: { start: null, end: null, current: false }, arrangement: null,
        publicLabel: null, confidential: false, industries: industryDescriptions(job.industryDescriptions) } });
    addRecord(roleId, { type: "create_record", id: roleId, kind: "role",
      fields: { title: job.jobTitle.trim() || "Role not specified", originalNarrative: "",
        dates: { start: job.startDate || null, end: job.endDate || null, current: job.current },
        arrangement: "employment", publicLabel: null, confidential: false, industries: [] } });
    const linkId = legacyCareerId(userId, "employed_by", job.id);
    if (!knownLinks.has(linkId)) {
      operations.push({ type: "create_link", id: linkId, fromId: roleId, toId: organisationId,
        kind: "employed_by", confidential: false, publicLabel: null });
      knownLinks.add(linkId);
    }
  }
  for (const entry of after.entries) {
    if (entry.status === "inactive") continue;
    const prior = before?.entries.find(item => item.id === entry.id);
    const priorRows = new Set((entry.kind === "skill" && prior?.skillItems?.length
      ? prior.skillItems : responsibilityRows(prior?.details ?? ""))
      .map(text => text.trim().toLocaleLowerCase("en-GB")));
    const sourceRows = entry.kind === "skill" && entry.skillItems?.length
      ? entry.skillItems : responsibilityRows(entry.details);
    const contextRows = entry.kind === "skill" && entry.skillItems?.length
      ? responsibilityRows(entry.details).filter(text => !sourceRows.includes(text) &&
        !responsibilityRows(prior?.details ?? "").includes(text)) : [];
    const rows = [...sourceRows.filter(text => !priorRows.has(text.trim().toLocaleLowerCase("en-GB"))),
      ...contextRows];
    if (!rows.length && prior) continue;
    const job = entry.kind === "experience" ? after.employment?.find(item => item.id === entry.employmentId) : null;
    const trustedRecordId = before?.careerProjection?.display[entry.id]?.recordId ??
      (job ? before?.careerProjection?.display[job.id]?.recordId : null);
    const subjectId = trustedRecordId && knownRecords.has(trustedRecordId) ? trustedRecordId
      : job ? legacyCareerId(userId, "role", job.id)
        : legacyCareerId(userId, entry.kind, entry.id);
    if (job && !trustedRecordId) {
      const organisationId = legacyCareerId(userId, "organisation", job.id);
      addRecord(organisationId, { type: "create_record", id: organisationId, kind: "organisation",
        fields: { title: job.company, originalNarrative: "", dates: { start: null, end: null, current: false },
          arrangement: null, publicLabel: null, confidential: false,
          industries: industryDescriptions(job.industryDescriptions) } });
      addRecord(subjectId, { type: "create_record", id: subjectId, kind: "role",
        fields: { title: job.jobTitle, originalNarrative: entry.details,
          dates: { start: job.startDate || null, end: job.endDate || null, current: job.current },
          arrangement: "employment", publicLabel: null, confidential: false, industries: [] } });
      const linkId = legacyCareerId(userId, "employed_by", job.id);
      if (!knownLinks.has(linkId)) {
        operations.push({ type: "create_link", id: linkId, fromId: subjectId, toId: organisationId,
          kind: "employed_by", confidential: false, publicLabel: null });
        knownLinks.add(linkId);
      }
    } else if (!job) {
      addRecord(subjectId, { type: "create_record", id: subjectId,
        kind: entry.kind === "education" ? "qualification" : entry.kind === "training" ? "learning"
          : entry.kind === "skill" ? "skill" : "other",
        fields: { title: entry.heading, originalNarrative: entry.details,
          dates: { start: null, end: null, current: false }, arrangement: null, publicLabel: null,
          confidential: false, industries: [] } });
    }
    for (const text of rows) {
      const factKey = `${subjectId}\0${text.trim().toLocaleLowerCase("en-GB")}`;
      if (knownFacts.has(factKey)) continue;
      const id = legacyCareerId(userId, "accepted_fact", `${entry.id}:${text}`);
      operations.push({ type: "add_assertion", id, subjectId, text, publicText: null,
        facets: entry.kind === "skill" && sourceRows.includes(text) ? ["skill"] : entry.rowFacets?.[text] ?? [],
        context: null });
      provenance[id] = { ...makeProvenance(text),
        ...(entry.kind === "skill" && sourceRows.includes(text)
          ? { captureContext: `cv_library:${libraryVersion}:entry:${entry.id}:skill:${sourceRows.indexOf(text)}` } : {}) };
      knownFacts.add(factKey);
    }
  }
  for (let offset = 0; offset < operations.length; offset += 20) {
    const [head] = await tx.select({ revision: careerHeads.revision }).from(careerHeads)
      .where(eq(careerHeads.userId, userId)).limit(1);
    if (!head) throw new Error("Experience version could not be read.");
    const batch = operations.slice(offset, offset + 20);
    const requestKey = `library:${libraryVersion}:career:${offset / 20}`;
    await saveCareerChangeIn(tx, userId, { expectedRevision: head.revision, requestKey, operations: batch }, provenance);
  }
}

/** Save the member's original answer before any optional model organisation is queued. */
export async function captureDirectCareerAnswerIn(tx: Tx, userId: string, library: CvLibrary,
  destination: { kind: "employment" | "evidence"; id: string }, answer: string,
  requestIdentity: string): Promise<void> {
  const sourceId = destination.kind === "employment"
    ? library.entries.find(row => row.kind === "experience" && row.employmentId === destination.id)?.id ?? destination.id
    : destination.id;
  const trustedId = sourceId ? library.careerProjection?.display[sourceId]?.recordId : null;
  const subjectId = trustedId ?? (destination.kind === "employment"
    ? legacyCareerId(userId, "role", destination.id)
    : legacyCareerId(userId, library.entries.find(row => row.id === destination.id)?.kind ?? "other", destination.id));
  const [subject] = await tx.select({ id: careerRecords.id }).from(careerRecords)
    .where(and(eq(careerRecords.userId, userId), eq(careerRecords.id, subjectId))).limit(1);
  if (!subject) throw new Error("The selected Experience item is no longer available.");
  const [head] = await tx.select({ revision: careerHeads.revision }).from(careerHeads)
    .where(eq(careerHeads.userId, userId)).limit(1);
  if (!head) throw new Error("Experience version could not be read.");
  const id = legacyCareerId(userId, "direct_answer", requestIdentity);
  await saveCareerChangeIn(tx, userId, { expectedRevision: head.revision,
    requestKey: `answer:${requestIdentity}`, operations: [{ type: "add_assertion", id, subjectId,
      text: answer, publicText: null, facets: [], context: null }] });
}

/** A deliberate edit revises the same fact; its original wording remains in the journal. */
export async function reviseDirectCareerAnswerIn(tx: Tx, userId: string, requestIdentity: string,
  original: string, revised: string): Promise<void> {
  if (revised === original) return;
  const id = legacyCareerId(userId, "direct_answer", requestIdentity);
  const [fact] = await tx.select().from(careerAssertions).where(and(eq(careerAssertions.userId, userId),
    eq(careerAssertions.id, id))).limit(1);
  if (!fact || (fact.text !== original && fact.text !== revised))
    throw new Error("This answer changed. Reload it before editing.");
  if (fact.text === revised) return;
  const [head] = await tx.select({ revision: careerHeads.revision }).from(careerHeads)
    .where(eq(careerHeads.userId, userId)).limit(1);
  if (!head) throw new Error("Experience version could not be read.");
  await saveCareerChangeIn(tx, userId, { expectedRevision: head.revision,
    requestKey: `answer_edit:${requestIdentity}`, operations: [{ type: "edit_assertion", id,
      expectedRevision: fact.revision, text: revised, publicText: fact.publicText,
      facets: fact.facets, context: fact.context ?? null }] });
}
