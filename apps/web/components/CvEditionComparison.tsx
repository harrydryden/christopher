import type { CvContent } from "@col/core/cv";

/** Read-only comparison of saved wording; no generated result overwrites an open editor. */
export function CvEditionComparison({ source, result, sourceLabel }: {
  source: CvContent; result: CvContent; sourceLabel: string;
}) {
  const original = new Map(source.sections.map(section => [section.entryId, section]));
  const changed = result.sections.filter(section => {
    const prior = original.get(section.entryId);
    return !prior || prior.heading !== section.heading ||
      JSON.stringify(prior.bullets) !== JSON.stringify(section.bullets) ||
      JSON.stringify(prior.skillItems ?? []) !== JSON.stringify(section.skillItems ?? []);
  });
  return <details className="border border-line-muted p-3 text-14">
    <summary className="cursor-pointer font-medium">Compare {sourceLabel} with this saved result</summary>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <div className="border border-line-muted p-3"><h3 className="font-medium">{sourceLabel} summary</h3>
        <p className="mt-2 whitespace-pre-wrap">{source.summary}</p></div>
      <div className="border border-line-muted p-3"><h3 className="font-medium">Saved Refine summary</h3>
        <p className="mt-2 whitespace-pre-wrap">{result.summary}</p></div>
    </div>
    {changed.length ? <div className="mt-3 space-y-3">{changed.map(section => {
      const prior = original.get(section.entryId);
      return <section key={section.entryId} className="border border-line-muted p-3">
        <h3 className="font-medium">{section.heading}</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div><p className="text-12 font-medium text-muted">{sourceLabel}</p>
            <ul className="list-disc pl-5">{(prior?.skillItems ?? prior?.bullets ?? []).map((item, index) => <li key={index}>{item}</li>)}</ul></div>
          <div><p className="text-12 font-medium text-muted">Saved Refine</p>
            <ul className="list-disc pl-5">{(section.skillItems ?? section.bullets).map((item, index) => <li key={index}>{item}</li>)}</ul></div>
        </div>
      </section>;
    })}</div> : <p className="mt-3 text-muted">The saved sections match this source; the summary and layout may still differ.</p>}
  </details>;
}
