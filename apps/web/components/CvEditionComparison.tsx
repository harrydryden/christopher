import { resolveCvTheme, type CvContent } from "@col/core/cv";
import type { CvTargetingView } from "@col/core/cv-targeting";
import type { CvEditingTargets } from "@col/core/cv-editing-modes";

type Section = CvContent["sections"][number];
type Row = { key: string; section: Section; position: number };
function rows(content: CvContent, targets?: CvEditingTargets | null): Row[] {
  const occurrence = new Map<string, number>();
  return content.sections.map((section, position) => {
    const stableId = targets?.sections[position]?.entryId === section.entryId
      ? targets.sections[position]!.sectionId : null;
    const count = (occurrence.get(section.entryId) ?? 0) + 1;
    occurrence.set(section.entryId, count);
    return { key: stableId ?? `${section.entryId}#${count}`, section, position };
  });
}
function wording(section: Section): string[] {
  return section.skillItems ?? section.bullets.map((bullet, index) =>
    section.bulletSignposts?.[index] ? `${section.bulletSignposts[index]}: ${bullet}` : bullet);
}

/** Read-only saved comparison; repeated wording cannot collapse into one map entry. */
export function CvEditionComparison({ source, result, sourceLabel, sourceTargets, resultTargets,
  sourceTargeting, resultTargeting }: {
  source: CvContent; result: CvContent; sourceLabel: string;
  sourceTargets?: CvEditingTargets | null; resultTargets?: CvEditingTargets | null;
  sourceTargeting?: CvTargetingView | null; resultTargeting?: CvTargetingView | null;
}) {
  const before = rows(source, sourceTargets);
  const after = rows(result, resultTargets);
  const old = new Map(before.map(row => [row.key, row]));
  const next = new Map(after.map(row => [row.key, row]));
  const removed = before.filter(row => !next.has(row.key));
  const changed = after.filter(row => {
    const prior = old.get(row.key);
    return !prior || prior.section.heading !== row.section.heading ||
      JSON.stringify(prior.section) !== JSON.stringify(row.section) ||
      prior.position !== row.position;
  });
  const priorPriorities = sourceTargeting?.priorities ?? [];
  const nextPriorities = resultTargeting?.priorities ?? [];
  const prioritiesChanged = sourceTargeting && resultTargeting &&
    JSON.stringify(priorPriorities.map(row => [row.id, row.text, row.essential])) !==
      JSON.stringify(nextPriorities.map(row => [row.id, row.text, row.essential]));
  const oldTreatment = new Map(sourceTargeting?.entries.map(row => [row.entryId, row.treatment]));
  const treatmentChanges = resultTargeting?.entries.filter(row => oldTreatment.has(row.entryId) &&
    oldTreatment.get(row.entryId) !== row.treatment) ?? [];
  const sourceTheme = resolveCvTheme(source.theme);
  const resultTheme = resolveCvTheme(result.theme);
  const layoutFields = ([ ["font", "Font"], ["bodySizePt", "Body size"], ["maxPages", "Page limit"],
    ["primary", "Primary colour"], ["background", "Background colour"], ["surface", "Panel colour"],
    ["pill", "Pill colour"], ["introPanel", "Summary panel"], ["skillPills", "Skill pills"] ] as const);
  const layoutChanges = layoutFields.filter(([field]) => sourceTheme[field] !== resultTheme[field]);
  return <details className="border border-line-muted p-3 text-14">
    <summary className="cursor-pointer font-medium">Compare {sourceLabel} with this saved result</summary>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <div className="border border-line-muted p-3"><h3 className="font-medium">{sourceLabel} summary</h3>
        <p className="mt-2 whitespace-pre-wrap">{source.summary}</p></div>
      <div className="border border-line-muted p-3"><h3 className="font-medium">Saved Refine summary</h3>
        <p className="mt-2 whitespace-pre-wrap">{result.summary}</p></div>
    </div>
    {(changed.length > 0 || removed.length > 0) ? <div className="mt-3 space-y-3">
      {removed.map(row => <section key={`removed:${row.key}`} className="border border-warn p-3">
        <h3 className="font-medium">Removed: {row.section.heading}</h3>
        <ul className="mt-2 list-disc pl-5">{wording(row.section).map((item, index) => <li key={index}>{item}</li>)}</ul>
      </section>)}
      {changed.map(row => { const prior = old.get(row.key); return <section key={`changed:${row.key}`} className="border border-line-muted p-3">
        <h3 className="font-medium">{prior ? row.position !== prior.position ? `Moved: ${row.section.heading}` : row.section.heading : `Added: ${row.section.heading}`}</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div><p className="text-12 font-medium text-muted">{sourceLabel}</p>
            <ul className="list-disc pl-5">{(prior ? wording(prior.section) : []).map((item, index) => <li key={index}>{item}</li>)}</ul></div>
          <div><p className="text-12 font-medium text-muted">Saved Refine</p>
            <ul className="list-disc pl-5">{wording(row.section).map((item, index) => <li key={index}>{item}</li>)}</ul></div>
        </div>
      </section>; })}
    </div> : <p className="mt-3 text-muted">The saved sections and their order match this source.</p>}
    {prioritiesChanged && <section className="mt-3 border border-line-muted p-3"><h3 className="font-medium">Role priorities changed</h3>
      <div className="mt-2 grid gap-3 sm:grid-cols-2"><div><p className="text-12">{sourceLabel}</p>
        <ol className="list-decimal pl-5">{priorPriorities.map(row => <li key={row.id}>{row.text}{row.essential ? " · Essential" : ""}</li>)}</ol></div>
        <div><p className="text-12">Saved Refine</p><ol className="list-decimal pl-5">{nextPriorities.map(row =>
          <li key={row.id}>{row.text}{row.essential ? " · Essential" : ""}</li>)}</ol></div></div></section>}
    {(!sourceTargeting || !resultTargeting) && <p className="mt-3 text-12 text-muted">
      Source priorities and evidence choices are unavailable for this historical edition; no unchanged comparison is claimed.
    </p>}
    {treatmentChanges.length > 0 && <section className="mt-3 border border-line-muted p-3"><h3 className="font-medium">Evidence treatment changed</h3>
      <ul className="mt-2 list-disc pl-5">{treatmentChanges.map(row => <li key={row.entryId}>
        {row.heading}: {oldTreatment.get(row.entryId)} → {row.treatment}</li>)}</ul></section>}
    {layoutChanges.length > 0 && <section className="mt-3 border border-line-muted p-3"><h3 className="font-medium">Layout changed</h3>
      <ul className="mt-1 list-disc pl-5">{layoutChanges.map(([field, label]) => <li key={field}>{label}: {String(sourceTheme[field] ?? "legacy")}
        {" → "}{String(resultTheme[field] ?? "legacy")}</li>)}</ul></section>}
  </details>;
}
