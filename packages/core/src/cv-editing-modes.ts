import { createHash } from "node:crypto";
import { z } from "zod";
import type { CvContent, CvLibrary } from "./cv";
import { BulletSignpostSchema, CvContentSchema, CvLibrarySchema, groupCvLibrary } from "./cv";
import { canonicalJson } from "./cv-review";
import { CvTargetingChoicesSchema } from "./cv-targeting";
import { CvThemeSchema, resolveCvTheme } from "./cv-theme";
import { CV_LIMITS } from "./cv-format";
import { cvTailoringEvidence } from "./cv-tailoring";
import { projectCvTargetedSections } from "./cv-targeting-projection";

/** Keep career citations anchored to immutable fact IDs when a CV view reorders its rows. */
export function cvStableEvidenceId(library: CvLibrary, sourceId: string): string {
  const ref = library.careerProjection?.sourceMap[sourceId];
  if (!ref) return sourceId;
  return ref.assertionId ? `career:assertion:${ref.assertionId}` : `career:narrative:${ref.recordId}`;
}

export function cvStableEvidence(library: CvLibrary) {
  return cvTailoringEvidence(library).map(row => {
    const ref = library.careerProjection?.sourceMap[row.id];
    return { ...row, id: cvStableEvidenceId(library, row.id),
      revision: ref?.assertionRevision ?? ref?.recordRevision ?? null };
  });
}

/** A null database mode means a historical CV whose provenance is not known. */
export const CvEditingModeSchema = z.enum(["auto", "refine", "manual"]);
export type CvEditingMode = z.infer<typeof CvEditingModeSchema>;
export const CV_REFINEMENT_LIMITS = { instructions: 20, instructionCharacters: 12_000 } as const;
/** Bump when fit selection or PDF layout changes in a way that changes an Auto result. */
export const CV_FIT_VERSION = "2026-11-02.1";
export const CV_RENDER_VERSION = "2026-11-02.1";

const uuid = z.string().uuid();
const itemIds = z.array(uuid).max(100);

/** Stable targets travel with an edition, not with a model's positional answer. */
export const CvEditingTargetsSchema = z.object({
  version: z.literal(1),
  summaryId: uuid,
  sections: z.array(z.object({
    // A saved CV can carry a longer historical source ID than today's Library entry schema.
    entryId: z.string().min(1),
    sectionId: uuid,
    bulletIds: itemIds,
    skillIds: itemIds,
  })).max(20),
}).superRefine((targets, ctx) => {
  const all = [targets.summaryId, ...targets.sections.flatMap(section =>
    [section.sectionId, ...section.bulletIds, ...section.skillIds])];
  if (new Set(all).size !== all.length) ctx.addIssue({ code: "custom", message: "CV editing target IDs must be unique." });
  if (new Set(targets.sections.map(section => section.entryId)).size !== targets.sections.length)
    ctx.addIssue({ code: "custom", message: "CV sections need distinct source IDs." });
});
export type CvEditingTargets = z.infer<typeof CvEditingTargetsSchema>;

export function cvEditingTargetsFor(content: CvContent, createId: () => string): CvEditingTargets {
  return CvEditingTargetsSchema.parse({ version: 1, summaryId: createId(),
    sections: content.sections.map(section => ({ entryId: section.entryId, sectionId: createId(),
      bulletIds: section.bullets.map(() => createId()), skillIds: (section.skillItems ?? []).map(() => createId()),
    })) });
}

/** A forged or stale item list must never attach an exact wording lock to another claim. */
export function validateCvEditingTargets(content: CvContent, raw: unknown): CvEditingTargets {
  const targets = CvEditingTargetsSchema.parse(raw);
  if (targets.sections.length !== content.sections.length) throw new Error("CV editing targets are out of date.");
  for (let i = 0; i < content.sections.length; i++) {
    const section = content.sections[i]!;
    const target = targets.sections[i]!;
    if (target.entryId !== section.entryId || target.bulletIds.length !== section.bullets.length ||
      target.skillIds.length !== (section.skillItems?.length ?? 0))
      throw new Error("CV editing targets are out of date.");
  }
  return targets;
}

/** Existing IDs may move with their own section; new IDs may only name genuinely new items. */
export function validateCvEditingTargetTransition(before: CvContent, beforeRaw: unknown,
  after: CvContent, afterRaw: unknown): CvEditingTargets {
  const previous = validateCvEditingTargets(before, beforeRaw);
  const next = validateCvEditingTargets(after, afterRaw);
  if (next.summaryId !== previous.summaryId) throw new Error("The summary target changed. Reload this CV.");
  const held = new Map<string, string>();
  for (const section of previous.sections) {
    held.set(section.sectionId, `section:${section.entryId}`);
    for (const id of section.bulletIds) held.set(id, `bullet:${section.entryId}`);
    for (const id of section.skillIds) held.set(id, `skill:${section.entryId}`);
  }
  for (const section of next.sections) {
    for (const [id, owner] of ([
      [section.sectionId, `section:${section.entryId}`],
      ...section.bulletIds.map(id => [id, `bullet:${section.entryId}`]),
      ...section.skillIds.map(id => [id, `skill:${section.entryId}`]),
    ] as Array<[string, string]>)) {
      if (held.has(id) && held.get(id) !== owner)
        throw new Error("A CV item target moved to another section. Reload this CV.");
    }
    const former = previous.sections.find(row => row.entryId === section.entryId);
    if (former && former.sectionId !== section.sectionId)
      throw new Error("A CV section target changed. Reload this CV.");
  }
  return next;
}

export const CvRefinementSchema = z.object({
  id: uuid,
  version: z.number().int().positive(),
  order: z.number().int().nonnegative(),
  kind: z.enum(["exact_wording", "instruction", "structured"]),
  target: z.object({ type: z.enum(["summary", "section", "bullet", "skill", "selection", "appearance"]), id: uuid.optional() }),
  text: z.string().max(40_000).optional(),
  bulletSignpost: BulletSignpostSchema.optional(),
  structured: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("targeting"), choices: CvTargetingChoicesSchema }),
    z.object({ kind: z.literal("appearance"), theme: CvThemeSchema }),
    z.object({ kind: z.literal("item_order"), sectionIds: z.array(uuid).max(20), itemIds: z.record(uuid, z.array(uuid).max(100)) }),
    z.object({ kind: z.literal("skill_selection"), runId: uuid, careerVersion: z.number().int().nonnegative(),
      sections: z.array(z.object({ entryId: z.string().min(1).max(100), sectionId: uuid,
        heading: z.string().trim().min(1).max(250),
        items: z.array(z.object({ id: uuid, bulletId: uuid, label: z.string().trim().min(1).max(CV_LIMITS.skillCharacters),
          sourceId: z.string().min(1).max(220), quote: z.string().trim().min(1).max(1600),
          sourceRef: z.object({ recordId: z.string().min(1), recordRevision: z.number().int().positive(),
            assertionId: z.string().nullable(), assertionRevision: z.number().int().positive().nullable(),
            publicText: z.boolean(), origin: z.literal("accepted_suggestion") }) })).min(1).max(CV_LIMITS.skillsPerSection) })).min(1).max(CV_LIMITS.skillSections) }),
  ]).optional(),
  dependencies: z.object({ descriptionVersionId: uuid, sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    sourceIds: z.array(z.string().min(1).max(220)).max(100), originBaselineId: uuid.nullable().optional() }),
  reset: z.boolean().default(false),
}).superRefine((row, ctx) => {
  if (row.kind !== "structured" && !row.reset && !row.text?.trim())
    ctx.addIssue({ code: "custom", message: "Give this refinement wording or an instruction." });
  if (row.kind === "exact_wording" && !row.target.id)
    ctx.addIssue({ code: "custom", message: "Exact wording needs a stable CV target." });
  if (row.kind === "structured" && !row.reset && !row.structured)
    ctx.addIssue({ code: "custom", message: "Structured refinements need validated choices." });
  if (row.kind !== "structured" && row.structured)
    ctx.addIssue({ code: "custom", message: "Wording refinements cannot carry structured choices." });
  if (row.bulletSignpost !== undefined && (row.kind !== "exact_wording" || row.target.type !== "bullet"))
    ctx.addIssue({ code: "custom", path: ["bulletSignpost"], message: "Only an exact bullet edit can set its title." });
});
export type CvRefinementV1 = z.infer<typeof CvRefinementSchema>;
export type CvRefinementConflict = { id: string; targetId?: string; reason: "missing_target" | "changed_source" | "changed_role" | "cannot_fit" | "duplicate_target" };


export function cvProjectSkillSelection(content: CvContent, targets: CvEditingTargets,
  choice: Extract<NonNullable<CvRefinementV1["structured"]>, { kind: "skill_selection" }>) {
  const next = structuredClone(content);
  const nextTargets = structuredClone(targets);
  const usedLabels = new Set(next.sections.filter(section => section.kind === "skill")
    .flatMap(section => section.skillItems ?? []).map(value => value.trim().toLocaleLowerCase("en-GB")));
  for (const selected of choice.sections) {
    const index = next.sections.findIndex(section => section.entryId === selected.entryId);
    if (index >= 0 && (next.sections[index]!.kind !== "skill" || nextTargets.sections[index]!.sectionId !== selected.sectionId))
      throw new Error("The selected skill section changed. Reload this CV.");
    const section = index >= 0 ? next.sections[index]! : {
      entryId: selected.entryId, kind: "skill" as const, heading: selected.heading,
      bullets: [] as string[], skillItems: [] as string[] };
    const ids = index >= 0 ? nextTargets.sections[index]! : {
      entryId: selected.entryId, sectionId: selected.sectionId, bulletIds: [] as string[], skillIds: [] as string[] };
    const skills = section.skillItems ?? [];
    for (const item of selected.items) {
      const label = item.label.trim().toLocaleLowerCase("en-GB");
      const heldIndex = skills.findIndex(value => value.trim().toLocaleLowerCase("en-GB") === label);
      if (heldIndex >= 0) {
        if (ids.skillIds[heldIndex] !== item.id) throw new Error("The selected skill target changed. Reload this CV.");
        continue;
      }
      if (usedLabels.has(label)) continue;
      skills.push(item.label); ids.skillIds.push(item.id); usedLabels.add(label);
    }
    section.skillItems = skills;
    const beforeBullets = section.bullets.length;
    section.bullets = skills.slice(0, CV_LIMITS.bulletsPerSection);
    for (let position = beforeBullets; position < section.bullets.length; position++) {
      const corresponding = selected.items.find(item => item.label === section.bullets[position]);
      if (!corresponding) throw new Error("The selected skill bullet lost its target.");
      ids.bulletIds.push(corresponding.bulletId);
    }
    if (index < 0) { next.sections.push(section); nextTargets.sections.push(ids); }
  }
  if (next.sections.length > CV_LIMITS.sections ||
    next.sections.filter(section => section.kind === "skill").length > CV_LIMITS.skillSections)
    throw new Error("The selected skills exceed this CV's section limit.");
  return { content: CvContentSchema.parse(next), targets: validateCvEditingTargets(next, nextTargets) };
}

function applyGeneratedSkillSelection(content: CvContent,
  choice: Extract<NonNullable<CvRefinementV1["structured"]>, { kind: "skill_selection" }>): CvContent {
  const next = structuredClone(content);
  const held = new Set(next.sections.filter(section => section.kind === "skill")
    .flatMap(section => section.skillItems ?? []).map(value => value.trim().toLocaleLowerCase("en-GB")));
  for (const selected of choice.sections) {
    const section = next.sections.find(item => item.entryId === selected.entryId);
    if (section && section.kind !== "skill") throw new Error("The selected skill section changed.");
    const target = section ?? { entryId: selected.entryId, kind: "skill" as const,
      heading: selected.heading, bullets: [] as string[], skillItems: [] as string[] };
    const items = target.skillItems ?? [];
    for (const item of selected.items) {
      const label = item.label.trim().toLocaleLowerCase("en-GB");
      if (!held.has(label)) { items.push(item.label); held.add(label); }
    }
    target.skillItems = items;
    target.bullets = items.slice(0, CV_LIMITS.bulletsPerSection);
    if (!section) next.sections.push(target);
  }
  return CvContentSchema.parse(next);
}

function withBulletSignpost(section: CvContent["sections"][number], index: number,
  bulletSignpost: string | null | undefined): CvContent["sections"][number] {
  if (bulletSignpost === undefined) return section;
  const signposts = section.bulletSignposts?.slice() ?? section.bullets.map(() => null);
  signposts[index] = bulletSignpost;
  return { ...section, bulletSignposts: signposts };
}

/** One free exact edit changes only its stable target on the selected saved edition. */
export function cvProjectOneExactWording(input: { content: CvContent; targets: CvEditingTargets;
  target: { type: "summary" | "section" | "bullet" | "skill"; id: string }; text: string;
  bulletSignpost?: string | null }): CvContent {
  const targets = validateCvEditingTargets(input.content, input.targets);
  if (!input.text.trim()) throw new Error("Give this CV item wording before saving it.");
  if (input.bulletSignpost !== undefined && input.target.type !== "bullet")
    throw new Error("Only a bullet can have a title.");
  const bulletSignpost = input.bulletSignpost === undefined ? undefined : BulletSignpostSchema.parse(input.bulletSignpost);
  const content = structuredClone(input.content);
  if (input.target.type === "summary" && input.target.id === targets.summaryId) {
    content.summary = input.text;
    content.summarySources = [];
    return CvContentSchema.parse(content);
  }
  for (let index = 0; index < targets.sections.length; index++) {
    const ids = targets.sections[index]!;
    const section = content.sections[index]!;
    if (input.target.type === "section" && input.target.id === ids.sectionId) {
      content.sections[index] = { ...section, heading: input.text };
      return CvContentSchema.parse(content);
    }
    const bullet = ids.bulletIds.indexOf(input.target.id);
    if (input.target.type === "bullet" && bullet >= 0) {
      content.sections[index] = withBulletSignpost({ ...section,
        bullets: section.bullets.map((value, position) => position === bullet ? input.text : value) }, bullet, bulletSignpost);
      return CvContentSchema.parse(content);
    }
    const skill = ids.skillIds.indexOf(input.target.id);
    if (input.target.type === "skill" && skill >= 0 && section.skillItems) {
      content.sections[index] = { ...section,
        skillItems: section.skillItems.map((value, position) => position === skill ? input.text : value) };
      return CvContentSchema.parse(content);
    }
  }
  throw new Error("This CV item changed. Reload the edition before saving wording.");
}

/** Apply approved wording literally. A moved/changed source is a conflict, never a fuzzy match. */
export function cvApplyExactLocks(input: { content: CvContent; targets: CvEditingTargets;
  refinements: CvRefinementV1[]; descriptionVersionId: string; sourceHash: string; library?: CvLibrary;
}): { content: CvContent; conflicts: CvRefinementConflict[] } {
  const targets = validateCvEditingTargets(input.content, input.targets);
  let content = structuredClone(input.content);
  const conflicts: CvRefinementConflict[] = [];
  const ordered = input.refinements.filter(row => !row.reset && row.kind === "exact_wording")
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const usedTargets = new Set<string>();
  for (const lock of ordered) {
    const targetId = lock.target.id;
    const conflict = (reason: CvRefinementConflict["reason"]) => conflicts.push({ id: lock.id, targetId, reason });
    if (targetId && usedTargets.has(targetId)) { conflict("duplicate_target"); continue; }
    if (targetId) usedTargets.add(targetId);
    if (lock.dependencies.descriptionVersionId !== input.descriptionVersionId) { conflict("changed_role"); continue; }
    const actualHash = input.library ? cvRefinementDependencies({ content: input.content, targets,
      library: input.library, descriptionVersionId: input.descriptionVersionId, target: lock.target }).sourceHash
      : input.sourceHash;
    if (lock.dependencies.sourceHash !== actualHash) { conflict("changed_source"); continue; }
    const text = lock.text ?? "";
    if (lock.target.type === "summary" && targetId === targets.summaryId) {
      content = { ...content, summary: text, summarySources: [] };
      continue;
    }
    const index = targets.sections.findIndex(section => section.sectionId === targetId);
    if (lock.target.type === "section" && index >= 0) {
      content.sections[index] = { ...content.sections[index]!, heading: text };
      continue;
    }
    let applied = false;
    for (let sectionIndex = 0; sectionIndex < targets.sections.length; sectionIndex++) {
      const sectionTargets = targets.sections[sectionIndex]!;
      const section = content.sections[sectionIndex]!;
      const bulletIndex = sectionTargets.bulletIds.indexOf(targetId ?? "");
      if (lock.target.type === "bullet" && bulletIndex >= 0) {
        content.sections[sectionIndex] = withBulletSignpost({ ...section,
          bullets: section.bullets.map((old, i) => i === bulletIndex ? text : old),
          bulletSources: text === section.bullets[bulletIndex] ? section.bulletSources : undefined },
          bulletIndex, lock.bulletSignpost);
        applied = true;
        break;
      }
      const skillIndex = sectionTargets.skillIds.indexOf(targetId ?? "");
      if (lock.target.type === "skill" && skillIndex >= 0 && section.skillItems) {
        content.sections[sectionIndex] = { ...section,
          skillItems: section.skillItems.map((old, i) => i === skillIndex ? text : old) };
        applied = true;
        break;
      }
    }
    if (!applied) conflict("missing_target");
  }
  if (!conflicts.length) {
    const parsed = CvContentSchema.safeParse(content);
    if (!parsed.success) for (const lock of ordered) conflicts.push({ id: lock.id, targetId: lock.target.id, reason: "cannot_fit" });
    else content = parsed.data;
  }
  return { content: conflicts.length ? input.content : content, conflicts };
}

/** Free Refine projection from an immutable Auto result; no author call is involved. */
export function cvProjectRefinements(input: { content: CvContent; targets: CvEditingTargets;
  library: CvLibrary; refinements: CvRefinementV1[]; descriptionVersionId: string;
  sourceHash: string }): { content: CvContent; targets: CvEditingTargets; conflicts: CvRefinementConflict[] } {
  validateCvEditingTargets(input.content, input.targets);
  let content = structuredClone(input.content);
  let targets = structuredClone(input.targets);
  const conflicts: CvRefinementConflict[] = [];
  const ordered = input.refinements.filter(row => !row.reset).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  for (const row of ordered.filter(item => item.kind === "structured")) {
    const choice = row.structured;
    if (!choice) { conflicts.push({ id: row.id, reason: "missing_target" }); continue; }
    if (choice.kind === "skill_selection") {
      try {
        const selected = cvProjectSkillSelection(content, targets, choice);
        content = selected.content; targets = selected.targets;
      } catch { conflicts.push({ id: row.id, reason: "missing_target" }); }
      continue;
    }
    if (choice.kind === "appearance") content.theme = choice.theme;
    if (choice.kind === "targeting") {
      const projected = projectCvTargetedSections(content, { entries: choice.choices.entries });
      content.sections = projected.sections;
      content.theme = { ...resolveCvTheme(content.theme), ...choice.choices.presentation };
      targets.sections = content.sections.map(section => {
        const prior = targets.sections.find(item => item.entryId === section.entryId)!;
        return { ...prior, bulletIds: prior.bulletIds.slice(0, section.bullets.length),
          skillIds: prior.skillIds.slice(0, section.skillItems?.length ?? 0) };
      });
    }
    if (choice.kind === "item_order") {
      const bySection = new Map(targets.sections.map((item, index) => [item.sectionId,
        { target: item, section: content.sections[index]! }]));
      if (choice.sectionIds.length !== targets.sections.length ||
        new Set(choice.sectionIds).size !== targets.sections.length ||
        choice.sectionIds.some(id => !bySection.has(id))) {
        conflicts.push({ id: row.id, reason: "missing_target" }); continue;
      }
      const reordered = choice.sectionIds.map(id => bySection.get(id)!);
      content.sections = reordered.map(item => item.section);
      targets.sections = reordered.map(item => item.target);
      for (let i = 0; i < targets.sections.length; i++) {
        const target = targets.sections[i]!;
        const section = content.sections[i]!;
        const requested = choice.itemIds[target.sectionId];
        if (!requested) continue;
        const held = section.skillItems ? target.skillIds : target.bulletIds;
        if (requested.length !== held.length || new Set(requested).size !== held.length ||
          requested.some(id => !held.includes(id))) {
          conflicts.push({ id: row.id, targetId: target.sectionId, reason: "missing_target" }); continue;
        }
        const indexes = requested.map(id => held.indexOf(id));
        targets.sections[i] = section.skillItems ? { ...target, skillIds: requested } : { ...target, bulletIds: requested };
        content.sections[i] = section.skillItems ? { ...section,
          skillItems: indexes.map(index => section.skillItems![index]!) } : { ...section,
          bullets: indexes.map(index => section.bullets[index]!),
          ...(section.bulletSources ? { bulletSources: indexes.map(index => section.bulletSources![index]!) } : {}),
          ...(section.bulletSignposts ? { bulletSignposts: indexes.map(index => section.bulletSignposts![index]!) } : {}) };
      }
    }
  }
  const exact = cvApplyExactLocks({ content, targets, refinements: ordered,
    descriptionVersionId: input.descriptionVersionId, sourceHash: input.sourceHash, library: input.library });
  conflicts.push(...exact.conflicts);
  content = exact.content;
  const parsed = CvContentSchema.safeParse(content);
  if (!parsed.success) conflicts.push(...ordered.map(row => ({ id: row.id, reason: "cannot_fit" as const })));
  return { content: conflicts.length || !parsed.success ? input.content : parsed.data,
    targets: conflicts.length ? input.targets : targets, conflicts };
}

/** Only eligible facts reach a Refine author request; appearance remains local. */
export function cvRefineWritingLibrary(library: CvLibrary, refinements: CvRefinementV1[]): CvLibrary {
  let result = structuredClone(library);
  for (const row of refinements.filter(item => !item.reset && item.kind === "structured")
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    const choice = row.structured;
    if (choice?.kind === "skill_selection") {
      for (const section of choice.sections) {
        const existing = result.entries.find(entry => entry.id === section.entryId && entry.kind === "skill");
        if (existing) existing.skillItems = [...new Set([...(existing.skillItems ?? []), ...section.items.map(item => item.label)])];
        else result.entries.push({ id: section.entryId, kind: "skill", heading: section.heading,
          details: section.items.map(item => item.label).join("\n"), skillItems: section.items.map(item => item.label) });
        if (result.careerProjection) {
          result.careerProjection.version = Math.max(result.careerProjection.version, choice.careerVersion);
          const saved = result.entries.find(entry => entry.id === section.entryId && entry.kind === "skill")!;
          for (const item of section.items) {
            const index = saved.skillItems!.indexOf(item.label);
            result.careerProjection.sourceMap[`entry:${section.entryId}:skill:${index}`] = item.sourceRef;
            if (!existing) result.careerProjection.sourceMap[`entry:${section.entryId}:row:${index}`] = item.sourceRef;
          }
        }
      }
    }
    if (choice?.kind === "appearance") result.theme = choice.theme;
    if (choice?.kind === "targeting") {
      const omitted = new Set(choice.choices.entries.filter(item => item.treatment === "omit").map(item => item.entryId));
      result.entries = result.entries.filter(entry => !omitted.has(entry.id));
      const retainedEmployment = new Set(result.entries.map(entry => entry.employmentId).filter(Boolean));
      if (result.employment) result.employment = result.employment.filter(row => retainedEmployment.has(row.id));
      if (omitted.size) result.profile = "";
      result.theme = { ...resolveCvTheme(result.theme), ...choice.choices.presentation };
    }
  }
  return CvLibrarySchema.parse(result);
}

export function cvRefinementConflicts(input: { content: CvContent; targets: CvEditingTargets;
  library: CvLibrary; descriptionVersionId: string; refinements: CvRefinementV1[] }): CvRefinementConflict[] {
  const conflicts: CvRefinementConflict[] = [];
  const held = new Set<string>();
  for (const row of input.refinements.filter(item => !item.reset)) {
    const targetId = row.target.id;
    if (targetId && held.has(targetId) && row.kind === "exact_wording") {
      conflicts.push({ id: row.id, targetId, reason: "duplicate_target" }); continue;
    }
    if (targetId && row.kind === "exact_wording") held.add(targetId);
    if (row.dependencies.descriptionVersionId !== input.descriptionVersionId) {
      conflicts.push({ id: row.id, targetId, reason: "changed_role" }); continue;
    }
    const targets = input.targets;
    if (targetId && targetId !== targets.summaryId && !targets.sections.some(section =>
      section.sectionId === targetId || section.bulletIds.includes(targetId) || section.skillIds.includes(targetId))) {
      conflicts.push({ id: row.id, targetId, reason: "missing_target" }); continue;
    }
    const actual = cvRefinementDependencies({ content: input.content, targets, library: input.library,
      descriptionVersionId: input.descriptionVersionId, target: row.target, structured: row.structured });
    if (actual.sourceHash !== row.dependencies.sourceHash)
      conflicts.push({ id: row.id, targetId, reason: "changed_source" });
  }
  return conflicts;
}

/** Apply structure after writing, resolving saved order IDs through exact source identity. */
export function cvApplyGeneratedStructure(input: { candidate: CvContent; source: CvContent;
  sourceTargets: CvEditingTargets; refinements: CvRefinementV1[] }): {
  content: CvContent; conflicts: CvRefinementConflict[] } {
  const targets = validateCvEditingTargets(input.source, input.sourceTargets);
  let content = structuredClone(input.candidate);
  const conflicts: CvRefinementConflict[] = [];
  for (const row of input.refinements.filter(item => item.kind === "structured" && !item.reset)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    const choice = row.structured;
    if (choice?.kind === "skill_selection") {
      try { content = applyGeneratedSkillSelection(content, choice); }
      catch { conflicts.push({ id: row.id, reason: "missing_target" }); }
      continue;
    }
    if (choice?.kind === "appearance") content.theme = choice.theme;
    if (choice?.kind === "targeting") {
      content.sections = projectCvTargetedSections(content, { entries: choice.choices.entries }).sections;
      content.theme = { ...resolveCvTheme(content.theme), ...choice.choices.presentation };
    }
    if (choice?.kind === "item_order") {
      const sourceOrder = choice.sectionIds.map(id => targets.sections.find(item => item.sectionId === id)?.entryId);
      if (sourceOrder.some(id => !id) || new Set(sourceOrder).size !== sourceOrder.length) {
        conflicts.push({ id: row.id, reason: "missing_target" }); continue;
      }
      content.sections.sort((a, b) => {
        const ai = sourceOrder.indexOf(a.entryId); const bi = sourceOrder.indexOf(b.entryId);
        return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
      });
      for (const [sectionId, orderedIds] of Object.entries(choice.itemIds)) {
        const sourceIndex = targets.sections.findIndex(item => item.sectionId === sectionId);
        if (sourceIndex < 0) { conflicts.push({ id: row.id, targetId: sectionId, reason: "missing_target" }); continue; }
        const sourceSection = input.source.sections[sourceIndex]!;
        const sourceTargets = targets.sections[sourceIndex]!;
        const currentIndex = content.sections.findIndex(item => item.entryId === sourceSection.entryId);
        if (currentIndex < 0) continue;
        const current = content.sections[currentIndex]!;
        const sourceIds = current.skillItems ? sourceTargets.skillIds : sourceTargets.bulletIds;
        if (orderedIds.length !== sourceIds.length || new Set(orderedIds).size !== orderedIds.length ||
          orderedIds.some(id => !sourceIds.includes(id))) {
          conflicts.push({ id: row.id, targetId: sectionId, reason: "missing_target" }); continue;
        }
        const mapped = orderedIds.map(id => {
          const sourceItem = sourceIds.indexOf(id);
          if (current.skillItems) {
            const label = sourceSection.skillItems?.[sourceItem];
            const matches = current.skillItems.flatMap((value, index) => value === label ? [index] : []);
            return matches.length === 1 ? matches[0]! : -1;
          }
          const citation = sourceSection.bulletSources?.[sourceItem];
          const signature = citation ? canonicalJson(citation) : null;
          const matches = current.bullets.flatMap((value, index) => signature &&
            canonicalJson(current.bulletSources?.[index]) === signature ? [index]
            : !signature && value === sourceSection.bullets[sourceItem] ? [index] : []);
          return matches.length === 1 ? matches[0]! : -1;
        });
        if (mapped.length !== (current.skillItems?.length ?? current.bullets.length) ||
          mapped.some(index => index < 0) || new Set(mapped).size !== mapped.length) {
          conflicts.push({ id: row.id, targetId: sectionId, reason: "missing_target" }); continue;
        }
        content.sections[currentIndex] = current.skillItems ? { ...current,
          skillItems: mapped.map(index => current.skillItems![index]!) } : { ...current,
          bullets: mapped.map(index => current.bullets[index]!),
          ...(current.bulletSources ? { bulletSources: mapped.map(index => current.bulletSources![index]!) } : {}),
          ...(current.bulletSignposts ? { bulletSignposts: mapped.map(index => current.bulletSignposts![index]!) } : {}) };
      }
    }
  }
  const parsed = CvContentSchema.safeParse(content);
  if (!parsed.success) conflicts.push(...input.refinements.filter(row => row.kind === "structured")
    .map(row => ({ id: row.id, reason: "cannot_fit" as const })));
  return { content: conflicts.length || !parsed.success ? input.candidate : parsed.data, conflicts };
}

/** Transfer only explicitly locked text from a saved source, by its stable target and entry ID. */
export function cvApplyGeneratedExactLocks(input: { candidate: CvContent; source: CvContent;
  sourceTargets: CvEditingTargets; library: CvLibrary; refinements: CvRefinementV1[];
  descriptionVersionId: string }): { content: CvContent; conflicts: CvRefinementConflict[] } {
  const originalTargets = validateCvEditingTargets(input.source, input.sourceTargets);
  const selections = input.refinements.filter(row => row.structured?.kind === "skill_selection" && !row.reset);
  const projectedSource = selections.length ? cvProjectRefinements({ content: input.source,
    targets: originalTargets, library: input.library, refinements: selections,
    descriptionVersionId: input.descriptionVersionId, sourceHash: "" }) : null;
  if (projectedSource?.conflicts.length) return { content: input.candidate,
    conflicts: projectedSource.conflicts };
  const source = projectedSource?.content ?? input.source;
  const sourceTargets = projectedSource?.targets ?? originalTargets;
  const library = selections.length ? cvRefineWritingLibrary(input.library, selections) : input.library;
  const content = structuredClone(input.candidate);
  const originalCandidate = input.candidate;
  const conflicts: CvRefinementConflict[] = [];
  const locks = input.refinements.filter(row => row.kind === "exact_wording" && !row.reset)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const used = new Set<string>();
  for (const lock of locks) {
    const id = lock.target.id;
    const issue = (reason: CvRefinementConflict["reason"]) => conflicts.push({ id: lock.id, targetId: id, reason });
    if (!id || used.has(id)) { issue(id ? "duplicate_target" : "missing_target"); continue; }
    used.add(id);
    if (lock.dependencies.descriptionVersionId !== input.descriptionVersionId) { issue("changed_role"); continue; }
    const dependency = cvRefinementDependencies({ content: source, targets: sourceTargets,
      library, descriptionVersionId: input.descriptionVersionId, target: lock.target });
    if (lock.dependencies.sourceHash !== dependency.sourceHash) { issue("changed_source"); continue; }
    const text = lock.text?.trim() ?? "";
    if (lock.target.type === "summary" && id === sourceTargets.summaryId) {
      content.summary = text; content.summarySources = [];
      continue;
    }
    const owner = sourceTargets.sections.find(section => section.sectionId === id ||
      section.bulletIds.includes(id) || section.skillIds.includes(id));
    if (!owner) { issue("missing_target"); continue; }
    const sectionIndex = content.sections.findIndex(section => section.entryId === owner.entryId);
    if (sectionIndex < 0) { issue("missing_target"); continue; }
    const section = content.sections[sectionIndex]!;
    if (lock.target.type === "section" && owner.sectionId === id) {
      content.sections[sectionIndex] = { ...section, heading: text };
    } else if (lock.target.type === "bullet" && owner.bulletIds.includes(id)) {
      const sourceIndex = owner.bulletIds.indexOf(id);
      const sourceSection = source.sections.find(item => item.entryId === owner.entryId)!;
      const originalSection = originalCandidate.sections.find(item => item.entryId === owner.entryId)!;
      const sourceRefs = sourceSection.bulletSources?.[sourceIndex]?.map(String).sort();
      const matches = originalSection.bullets.flatMap((value, index) => {
        const refs = originalSection.bulletSources?.[index]?.map(String).sort();
        return sourceRefs?.length && refs?.length && canonicalJson(refs) === canonicalJson(sourceRefs)
          ? [index] : !sourceRefs?.length && value === sourceSection.bullets[sourceIndex] ? [index] : [];
      });
      if (matches.length !== 1) { issue("missing_target"); continue; }
      const bulletIndex = matches[0]!;
      content.sections[sectionIndex] = withBulletSignpost({ ...section,
        bullets: section.bullets.map((value, index) => index === bulletIndex ? text : value) },
        bulletIndex, lock.bulletSignpost);
    } else if (lock.target.type === "skill" && owner.skillIds.includes(id) && section.skillItems) {
      const sourceIndex = owner.skillIds.indexOf(id);
      const sourceSection = source.sections.find(item => item.entryId === owner.entryId)!;
      const original = sourceSection.skillItems?.[sourceIndex];
      const matches = section.skillItems.flatMap((value, index) => value === original ? [index] : []);
      if (matches.length !== 1) { issue("missing_target"); continue; }
      content.sections[sectionIndex] = { ...section,
        skillItems: section.skillItems.map((value, index) => index === matches[0] ? text : value) };
    } else issue("missing_target");
  }
  const parsed = CvContentSchema.safeParse(content);
  if (!parsed.success) for (const lock of locks) if (!conflicts.some(row => row.id === lock.id))
    conflicts.push({ id: lock.id, targetId: lock.target.id, reason: "cannot_fit" });
  return { content: conflicts.length || !parsed.success ? input.candidate : parsed.data, conflicts };
}

/** Source and engine identity for Auto; refinement and manual text are deliberately absent. */
export type CvAutoInputV1 = {
  version: 1;
  contextId: string;
  descriptionVersionId: string;
  jobTitle: string;
  companyName: string;
  description: string;
  library: CvLibrary;
  basePriorityIdentity: string;
  appearance: CvContent["theme"];
  writingPreferences: { stylePreferences?: string; preferredWording?: string };
  routes: Record<string, { model: string; effort: "low" | "medium" | "high" | "xhigh" | "max"; serviceTier?: string }>;
  contracts: { promptSet: string; review: string; fit: string; render: string };
};

export function cvAutoInputKey(input: CvAutoInputV1): string {
  if (input.version !== 1) throw new Error("Unsupported Auto input version.");
  return createHash("sha256").update(canonicalJson({ ...input,
    library: groupCvLibrary(input.library),
  })).digest("hex");
}

export function cvRefinementSourceIdentity(source: { content: CvContent; librarySnapshot: CvLibrary;
  jobDescription: string; descriptionVersionId: string | null }): string {
  return createHash("sha256").update(canonicalJson(source)).digest("hex");
}

/** A target depends on its cited confirmed rows, or its whole entry when uncited. */
export function cvRefinementDependencies(input: { content: CvContent; targets: CvEditingTargets;
  library: CvLibrary; descriptionVersionId: string; target: CvRefinementV1["target"];
  structured?: CvRefinementV1["structured"] }) {
  const targets = validateCvEditingTargets(input.content, input.targets);
  const evidence = cvStableEvidence(input.library);
  const byId = new Map(evidence.map(row => [row.id, [row.text, row.revision]]));
  const refs = (items?: Array<string | { sourceId: string }>) => items?.map(item =>
    cvStableEvidenceId(input.library, typeof item === "string" ? item : item.sourceId)) ?? [];
  let sourceIds: string[] = [];
  let ownerEntryId: string | null = null;
  if (input.target.type === "summary" && input.target.id === targets.summaryId)
    sourceIds = refs(input.content.summarySources);
  else if (input.target.type === "appearance" || input.structured?.kind === "appearance")
    sourceIds = [];
  else if (input.structured?.kind === "item_order") {
    const orderedEntries = new Set(input.structured.sectionIds.map(id =>
      targets.sections.find(section => section.sectionId === id)?.entryId).filter(Boolean));
    sourceIds = evidence.filter(row => row.entryId && orderedEntries.has(row.entryId)).map(row => row.id);
  } else if (input.target.type === "selection")
    sourceIds = evidence.map(row => row.id);
  else {
    const index = targets.sections.findIndex(section => section.sectionId === input.target.id ||
      section.bulletIds.includes(input.target.id ?? "") || section.skillIds.includes(input.target.id ?? ""));
    if (index >= 0) {
      const targetSection = targets.sections[index]!;
      const section = input.content.sections[index]!;
      ownerEntryId = section.entryId;
      const bulletIndex = targetSection.bulletIds.indexOf(input.target.id ?? "");
      sourceIds = bulletIndex >= 0 ? refs(section.bulletSources?.[bulletIndex])
        : input.target.type === "section" ? (section.bulletSources ?? []).flatMap(refs) : [];
      if (!sourceIds.length) sourceIds = evidence.filter(row => row.entryId === ownerEntryId).map(row => row.id);
    }
  }
  if (!sourceIds.length && input.target.type === "summary") sourceIds = ["source:profile"];
  sourceIds = [...new Set(sourceIds)].sort();
  const sourceHash = createHash("sha256").update(canonicalJson({
    descriptionVersionId: input.descriptionVersionId, ownerEntryId,
    evidence: sourceIds.map(id => [id, byId.get(id) ?? null]),
  })).digest("hex");
  return { sourceIds, sourceHash };
}

/** Carry only source-stable IDs into a newly generated baseline. Ambiguity gets a fresh ID. */
export function cvCarryEditingTargets(input: { priorContent: CvContent; priorTargets: CvEditingTargets;
  priorLibrary: CvLibrary; priorDescriptionVersionId: string; content: CvContent;
  library: CvLibrary; descriptionVersionId: string; createId: () => string }): CvEditingTargets {
  const prior = validateCvEditingTargets(input.priorContent, input.priorTargets);
  const next = cvEditingTargetsFor(input.content, input.createId);
  if (input.priorDescriptionVersionId !== input.descriptionVersionId) return next;
  const sameDependency = (a: CvRefinementV1["target"], b: CvRefinementV1["target"]) =>
    cvRefinementDependencies({ content: input.priorContent, targets: prior, library: input.priorLibrary,
      descriptionVersionId: input.priorDescriptionVersionId, target: a }).sourceHash ===
    cvRefinementDependencies({ content: input.content, targets: next, library: input.library,
      descriptionVersionId: input.descriptionVersionId, target: b }).sourceHash;
  if (sameDependency({ type: "summary", id: prior.summaryId }, { type: "summary", id: next.summaryId }))
    next.summaryId = prior.summaryId;
  for (let index = 0; index < next.sections.length; index++) {
    const target = next.sections[index]!;
    const oldIndex = prior.sections.findIndex(row => row.entryId === target.entryId);
    if (oldIndex < 0) continue;
    const old = prior.sections[oldIndex]!;
    if (sameDependency({ type: "section", id: old.sectionId }, { type: "section", id: target.sectionId }))
      target.sectionId = old.sectionId;
    const oldSection = input.priorContent.sections[oldIndex]!;
    const newSection = input.content.sections[index]!;
    for (let i = 0; i < newSection.bullets.length; i++) {
      const refs = newSection.bulletSources?.[i];
      if (!refs?.length) continue;
      const signature = canonicalJson(refs.map(ref => cvStableEvidenceId(input.library, ref)).sort());
      const oldMatches = oldSection.bullets.flatMap((_text, n) =>
        oldSection.bulletSources?.[n]?.length && canonicalJson(oldSection.bulletSources[n]!.map(ref =>
          cvStableEvidenceId(input.priorLibrary, ref)).sort()) === signature ? [n] : []);
      const newMatches = newSection.bullets.flatMap((_text, n) =>
        newSection.bulletSources?.[n]?.length && canonicalJson(newSection.bulletSources[n]!.map(ref =>
          cvStableEvidenceId(input.library, ref)).sort()) === signature ? [n] : []);
      if (oldMatches.length === 1 && newMatches.length === 1 &&
        sameDependency({ type: "bullet", id: old.bulletIds[oldMatches[0]!] },
          { type: "bullet", id: target.bulletIds[i] })) target.bulletIds[i] = old.bulletIds[oldMatches[0]!]!;
    }
    for (let i = 0; i < (newSection.skillItems?.length ?? 0); i++) {
      const label = newSection.skillItems![i]!;
      const oldMatches = oldSection.skillItems?.flatMap((text, n) => text === label ? [n] : []) ?? [];
      const newMatches = newSection.skillItems?.filter(text => text === label) ?? [];
      if (oldMatches.length === 1 && newMatches.length === 1 &&
        sameDependency({ type: "skill", id: old.skillIds[oldMatches[0]!] },
          { type: "skill", id: target.skillIds[i] })) target.skillIds[i] = old.skillIds[oldMatches[0]!]!;
    }
  }
  return validateCvEditingTargets(input.content, next);
}

/** Unlike Auto, a refined result depends on the exact ordered, versioned overlay. */
export function cvRefinedResultKey(sourceIdentity: string, refinements: CvRefinementV1[],
  contracts: CvAutoInputV1["contracts"] & { routes?: CvAutoInputV1["routes"] }): string {
  const active = refinements.filter(row => !row.reset).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return createHash("sha256").update(canonicalJson({ sourceIdentity, active, contracts })).digest("hex");
}
