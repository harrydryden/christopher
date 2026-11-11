import { z } from "zod";
import type { CvLibrary } from "./cv";

export const CareerRecordKindSchema = z.enum(["organisation", "engagement", "role", "project", "contribution", "learning", "qualification", "skill", "other"]);
export const CareerLinkKindSchema = z.enum(["employed_by", "contracted_through", "delivered_for", "part_of", "contributed_to", "member_of"]);
export const CareerFacetSchema = z.enum(["responsibility", "problem", "outcome", "metric", "milestone", "style", "skill"]);
export const CareerDateSchema = z.string().regex(/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/).nullable();
export const CareerDatesSchema = z.object({ start: CareerDateSchema, end: CareerDateSchema, current: z.boolean() })
  .refine(value => !value.current || value.end === null, "Current work cannot have an end date.")
  .refine(value => !value.start || !value.end || value.start.padEnd(7, "-01") <= value.end.padEnd(7, "-12"),
    "An end date cannot be before its start date.");
export const CareerRecordFieldsSchema = z.object({
  title: z.string().trim().min(1).max(250),
  originalNarrative: z.string().trim().max(40_000),
  dates: CareerDatesSchema,
  arrangement: z.enum(["employment", "contract", "consultancy", "fractional", "self_employed", "voluntary", "other"]).nullable(),
  publicLabel: z.string().trim().max(250).nullable(),
  confidential: z.boolean(),
  industries: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
});
export const CareerProvenanceSchema = z.object({
  kind: z.enum(["direct_user", "legacy_saved", "document", "model"]),
  sourceId: z.string().max(200).nullable(),
  quote: z.string().max(4000).nullable(),
  originalText: z.string().max(40_000),
  captureContext: z.string().max(200).nullable(),
});
export const CareerAssertionContextSchema = z.object({
  attribute: z.string().trim().min(1).max(120),
  scope: z.string().trim().min(1).max(120),
  period: z.string().trim().max(40).nullable(),
  value: z.string().trim().min(1).max(200),
}).nullable();
export const CareerOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_record"), id: z.string().uuid(), kind: CareerRecordKindSchema, fields: CareerRecordFieldsSchema }),
  z.object({ type: z.literal("edit_record"), id: z.string().uuid(), expectedRevision: z.number().int().positive(), fields: CareerRecordFieldsSchema }),
  z.object({ type: z.literal("archive_record"), id: z.string().uuid(), expectedRevision: z.number().int().positive(), archived: z.boolean() }),
  z.object({ type: z.literal("create_link"), id: z.string().uuid(), fromId: z.string().uuid(), toId: z.string().uuid(), kind: CareerLinkKindSchema, confidential: z.boolean(), publicLabel: z.string().trim().max(250).nullable() }),
  z.object({ type: z.literal("remove_link"), id: z.string().uuid(), expectedRevision: z.number().int().positive() }),
  z.object({ type: z.literal("add_assertion"), id: z.string().uuid(), subjectId: z.string().uuid(), text: z.string().trim().min(1).max(40_000), publicText: z.string().trim().min(1).max(4000).nullable().default(null), facets: z.array(CareerFacetSchema).max(7), context: CareerAssertionContextSchema.default(null) }),
  z.object({ type: z.literal("edit_assertion"), id: z.string().uuid(), expectedRevision: z.number().int().positive(), text: z.string().trim().min(1).max(40_000), publicText: z.string().trim().min(1).max(4000).nullable().optional(), facets: z.array(CareerFacetSchema).max(7), context: CareerAssertionContextSchema.default(null) }),
  z.object({ type: z.literal("retract_assertion"), id: z.string().uuid(), expectedRevision: z.number().int().positive(), retracted: z.boolean() }),
  z.object({ type: z.literal("save_perspective"), id: z.string().uuid(), expectedRevision: z.number().int().nonnegative(), label: z.string().trim().min(1).max(200), assertionIds: z.array(z.string().uuid()).max(100), note: z.string().trim().max(2000) }),
  z.object({ type: z.literal("remove_perspective"), id: z.string().uuid(), expectedRevision: z.number().int().positive() }),
]);
export const CareerChangeSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  requestKey: z.string().trim().min(1).max(120),
  operations: z.array(CareerOperationSchema).min(1).max(20),
});
export type CareerChange = z.infer<typeof CareerChangeSchema>;
export type CareerOperation = z.infer<typeof CareerOperationSchema>;
export type CareerRecordFields = z.infer<typeof CareerRecordFieldsSchema>;
export type CareerProvenance = z.infer<typeof CareerProvenanceSchema>;
export type CareerAssertionContext = z.infer<typeof CareerAssertionContextSchema>;

export type CareerRecordView = { id: string; kind: z.infer<typeof CareerRecordKindSchema>; revision: number;
  fields: CareerRecordFields; provenance: CareerProvenance; archived: boolean; createdAt: string; updatedAt: string };
export type CareerRecordSummary = Pick<CareerRecordView, "id" | "kind" | "revision" | "archived" | "updatedAt"> & {
  title: string; dates: CareerRecordFields["dates"]; publicLabel: string | null; confidential: boolean };
export type CareerLinkView = { id: string; fromId: string; toId: string; kind: z.infer<typeof CareerLinkKindSchema>;
  revision: number; confidential: boolean; publicLabel: string | null; otherTitle: string; archived: boolean };
export type CareerAssertionView = { id: string; subjectId: string; revision: number; text: string;
  publicText: string | null;
  facets: z.infer<typeof CareerFacetSchema>[]; status: "usable" | "proposed" | "retracted";
  provenance: CareerProvenance; context: CareerAssertionContext; createdAt: string; updatedAt: string };
export type CareerPerspectiveView = { id: string; revision: number; label: string; note: string;
  assertionIds: string[]; archived: boolean };
export type CareerConflictView = { id: string; subjectId: string; assertionIds: string[]; reason: string };
export type CareerChangeSummary = { id: string; revision: number; changedIds: string[]; undoOf: string | null; createdAt: string };
export type CareerWorkspace = { revision: number; records: CareerRecordSummary[]; nextCursor: string | null;
  skillChoices: string[];
  selected: { record: CareerRecordView; effectiveConfidential: boolean;
    assertions: CareerAssertionView[]; links: CareerLinkView[];
    perspectives: CareerPerspectiveView[]; changes: CareerChangeSummary[];
    assertionsNextCursor: string | null; linksNextCursor: string | null; changesNextCursor: number | null } | null;
  conflicts: CareerConflictView[] };
export type CareerChangeResult = { ok: true; revision: number; changeId: string; changedIds: string[];
  conflicts: CareerConflictView[] } | { ok: false; error: string };
export type CareerSourceRef = { recordId: string; recordRevision: number;
  assertionId: string | null; assertionRevision: number | null; publicText: boolean };
export type CareerSourceMap = Record<string, CareerSourceRef>;
export type CareerPresentation = "chronological" | "project" | "hybrid";
export type CareerDisplayEntry = { recordId: string; kind: "role" | "engagement" | "project" | "contribution" | "qualification" | "learning" | "skill" | "other";
  title: string; organisationLabel: string | null; dates: { start: string | null; end: string | null; current: boolean };
  publicLabel: string | null; groupRecordId: string | null };
export type CareerCvProjection = { careerVersion: number; presentation: CareerPresentation; library: CvLibrary;
  sourceMap: CareerSourceMap; display: Record<string, CareerDisplayEntry>;
  excluded: Array<{ recordId: string; assertionId?: string; reason: "confidential" | "capacity" | "ineligible" | "conflict" }> };

/** Shared conflict identity for the live workspace and a retained historical CV snapshot. */
export function careerConflictingGroups<T extends { id: string; subjectId: string; context: CareerAssertionContext;
  status: "usable" | "proposed" | "retracted"; provenance: { kind: string } }>(assertions: T[]) {
  const groups = new Map<string, T[]>();
  for (const assertion of assertions) if (assertion.status === "usable" &&
    assertion.provenance.kind !== "model" && assertion.context) {
    const { attribute, scope, period } = assertion.context;
    const key = careerCanonicalJson([assertion.subjectId, attribute.toLowerCase(), scope.toLowerCase(), period]);
    groups.set(key, [...(groups.get(key) ?? []), assertion]);
  }
  return [...groups].filter(([, rows]) => new Set(rows.map(row => row.context!.value.toLowerCase())).size > 1)
    .map(([key, rows]) => ({ key, rows }));
}

/** Privacy travels from private client/work context to its work descendants, not to unrelated roles. */
export function careerPrivateRecordIds(records: Array<{ id: string; confidential: boolean }>,
  links: Array<{ fromId: string; toId: string; kind: string; confidential: boolean; archived: boolean }>): Set<string> {
  const hidden = new Set(records.filter(row => row.confidential).map(row => row.id));
  for (const link of links) if (!link.archived && link.confidential) hidden.add(link.fromId);
  const children = new Map<string, string[]>();
  for (const link of links) {
    if (link.archived || !["part_of", "contributed_to", "employed_by", "contracted_through", "delivered_for"].includes(link.kind)) continue;
    children.set(link.toId, [...(children.get(link.toId) ?? []), link.fromId]);
  }
  const queue = [...hidden];
  for (let index = 0; index < queue.length; index++) {
    for (const child of children.get(queue[index]!) ?? []) if (!hidden.has(child)) {
      hidden.add(child);
      queue.push(child);
    }
  }
  return hidden;
}

/** Object-key order is irrelevant to a retry; operation order and text remain meaningful. */
export function careerCanonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
