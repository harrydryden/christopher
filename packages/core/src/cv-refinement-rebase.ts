import type { CvContent, CvLibrary } from "./cv";
import type { CvRubric } from "./cv-assessment";
import { canonicalJson } from "./cv-review";
import { cvRefinementDependencies, cvStableEvidence, cvStableEvidenceId, validateCvEditingTargets,
  type CvEditingTargets, type CvRefinementV1 } from "./cv-editing-modes";

export type CvRefinementRebaseReason = "changed_role" | "changed_source" | "missing_target" |
  "ambiguous_target" | "manual_origin";
export type CvRefinementRebaseItem = { id: string; status: "compatible"; target: CvRefinementV1["target"];
  structured?: CvRefinementV1["structured"]; sourceIds: string[]; sourceHash: string } |
  { id: string; status: "current" } |
  { id: string; status: "conflict"; reason: CvRefinementRebaseReason };
export type CvRefinementRebaseSource = { id: string; descriptionVersionId: string; content: CvContent;
  targets: CvEditingTargets; library: CvLibrary; rubric: CvRubric | null };

const refs = (items?: Array<string | { sourceId: string }>) =>
  (items ?? []).map(item => typeof item === "string" ? item : item.sourceId).sort();
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const label = (text: string) => text.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-GB");

function owner(source: CvRefinementRebaseSource, target: CvRefinementV1["target"]) {
  if (!target.id) return null;
  for (let index = 0; index < source.targets.sections.length; index++) {
    const ids = source.targets.sections[index]!;
    const section = source.content.sections[index]!;
    if (ids.sectionId === target.id || ids.bulletIds.includes(target.id) || ids.skillIds.includes(target.id))
      return { ids, section, index };
  }
  return null;
}

function mapTarget(from: CvRefinementRebaseSource, to: CvRefinementRebaseSource,
  target: CvRefinementV1["target"]): { target: CvRefinementV1["target"] } | { reason: CvRefinementRebaseReason } {
  if (target.type === "summary") return target.id === from.targets.summaryId
    ? { target: { type: "summary", id: to.targets.summaryId } } : { reason: "missing_target" };
  if (target.type === "selection" || target.type === "appearance")
    return !target.id ? { target } : { reason: "missing_target" };
  const prior = owner(from, target);
  if (!prior) return { reason: "missing_target" };
  const index = to.targets.sections.findIndex(section => section.entryId === prior.section.entryId);
  if (index < 0) return { reason: "missing_target" };
  const next = to.targets.sections[index]!;
  const nextSection = to.content.sections[index]!;
  if (target.type === "section") return { target: { type: "section", id: next.sectionId } };
  if (target.type === "bullet") {
    const oldIndex = prior.ids.bulletIds.indexOf(target.id!);
    if (oldIndex < 0) return { reason: "missing_target" };
    if (next.bulletIds.includes(target.id!)) return { target };
    const cited = refs(prior.section.bulletSources?.[oldIndex]).map(id => cvStableEvidenceId(from.library, id)).sort();
    if (!cited.length) return { reason: "ambiguous_target" };
    const oldMatches = prior.section.bullets.flatMap((_, i) =>
      same(refs(prior.section.bulletSources?.[i]).map(id => cvStableEvidenceId(from.library, id)).sort(), cited) ? [i] : []);
    const newMatches = nextSection.bullets.flatMap((_, i) =>
      same(refs(nextSection.bulletSources?.[i]).map(id => cvStableEvidenceId(to.library, id)).sort(), cited) ? [i] : []);
    if (oldMatches.length !== 1 || newMatches.length !== 1)
      return { reason: "ambiguous_target" };
    return { target: { type: "bullet", id: next.bulletIds[newMatches[0]!] } };
  }
  const oldIndex = prior.ids.skillIds.indexOf(target.id!);
  if (oldIndex < 0) return { reason: "missing_target" };
  if (next.skillIds.includes(target.id!)) return { target };
  const key = label(prior.section.skillItems?.[oldIndex] ?? "");
  const oldMatches = (prior.section.skillItems ?? []).filter(text => label(text) === key);
  const newMatches = (nextSection.skillItems ?? []).flatMap((text, i) => label(text) === key ? [i] : []);
  if (!key || oldMatches.length !== 1 || newMatches.length !== 1)
    return { reason: "ambiguous_target" };
  return { target: { type: "skill", id: next.skillIds[newMatches[0]!] } };
}

function exactEvidence(from: CvRefinementRebaseSource, to: CvRefinementRebaseSource,
  ids: string[]): boolean {
  if (!ids.length) return false;
  const old = new Map(cvStableEvidence(from.library).map(row => [row.id, [row.text, row.revision]]));
  const next = new Map(cvStableEvidence(to.library).map(row => [row.id, [row.text, row.revision]]));
  return ids.every(id => old.has(id) && next.has(id) && same(old.get(id), next.get(id)));
}

/** A proposed transfer is proof about the two immutable sources, never an index or text guess. */
export function cvPreviewRefinementRebase(input: { from: CvRefinementRebaseSource;
  to: CvRefinementRebaseSource; refinements: CvRefinementV1[] }): CvRefinementRebaseItem[] {
  const from = { ...input.from, targets: validateCvEditingTargets(input.from.content, input.from.targets) };
  const to = { ...input.to, targets: validateCvEditingTargets(input.to.content, input.to.targets) };
  const sameRubric = !!from.rubric && !!to.rubric && same(from.rubric, to.rubric);
  return input.refinements.filter(row => !row.reset).map(row => {
    const conflict = (reason: CvRefinementRebaseReason): CvRefinementRebaseItem =>
      ({ id: row.id, status: "conflict", reason });
    if (row.dependencies.originBaselineId === null) return conflict("manual_origin");
    if (row.dependencies.originBaselineId === to.id) {
      const current = cvRefinementDependencies({ content: to.content, targets: to.targets,
        library: to.library, descriptionVersionId: to.descriptionVersionId,
        target: row.target, structured: row.structured });
      return row.dependencies.descriptionVersionId === to.descriptionVersionId &&
        current.sourceHash === row.dependencies.sourceHash && same(current.sourceIds, row.dependencies.sourceIds)
        ? { id: row.id, status: "current" } : conflict("changed_source");
    }
    if (row.dependencies.originBaselineId && row.dependencies.originBaselineId !== from.id)
      return conflict("manual_origin");
    if (row.dependencies.descriptionVersionId !== from.descriptionVersionId)
      return conflict("changed_role");
    const prior = cvRefinementDependencies({ content: from.content, targets: from.targets,
      library: from.library, descriptionVersionId: from.descriptionVersionId,
      target: row.target, structured: row.structured });
    if (prior.sourceHash !== row.dependencies.sourceHash || !same(prior.sourceIds, row.dependencies.sourceIds))
      return conflict("manual_origin");
    const mapped = mapTarget(from, to, row.target);
    if ("reason" in mapped) return conflict(mapped.reason);
    // A changed advert may keep an exact source rubric; a different rubric cannot inherit old role rules.
    if (from.descriptionVersionId !== to.descriptionVersionId && row.target.type !== "appearance" &&
        row.structured?.kind !== "appearance" && !sameRubric) return conflict("changed_role");
    let structured = row.structured;
    if (structured?.kind === "targeting") {
      if (!sameRubric || !same(from.library.entries.map(entry => entry.id).sort(),
        to.library.entries.map(entry => entry.id).sort())) return conflict("changed_role");
    }
    if (structured?.kind === "item_order") {
      const sectionIds: string[] = [];
      const itemIds: Record<string, string[]> = {};
      for (const sectionId of structured.sectionIds) {
        const section = mapTarget(from, to, { type: "section", id: sectionId });
        if ("reason" in section || !section.target.id) return conflict("missing_target");
        sectionIds.push(section.target.id);
        const oldItems = structured.itemIds[sectionId];
        if (oldItems) {
          const priorSection = from.targets.sections.find(item => item.sectionId === sectionId)!;
          const kind = from.content.sections[from.targets.sections.indexOf(priorSection)]?.skillItems ? "skill" : "bullet";
          const mappedItems: string[] = [];
          for (const id of oldItems) {
            const item = mapTarget(from, to, { type: kind, id });
            if ("reason" in item || !item.target.id) return conflict("missing_target");
            mappedItems.push(item.target.id);
          }
          itemIds[section.target.id] = mappedItems;
        }
      }
      structured = { kind: "item_order", sectionIds, itemIds };
    }
    const next = cvRefinementDependencies({ content: to.content, targets: to.targets,
      library: to.library, descriptionVersionId: to.descriptionVersionId,
      target: mapped.target, structured });
    if (row.target.type !== "appearance" && row.structured?.kind !== "appearance" &&
        (!same(prior.sourceIds, next.sourceIds) || !exactEvidence(from, to, prior.sourceIds)))
      return conflict("changed_source");
    return { id: row.id, status: "compatible", target: mapped.target,
      structured, sourceIds: next.sourceIds, sourceHash: next.sourceHash };
  });
}
