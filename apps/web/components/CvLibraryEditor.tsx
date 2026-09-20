"use client";
import { useActionState, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { EVIDENCE_FACET_PROMPTS, employmentCompanyGroups, employmentHeading, isActiveEvidence, normaliseCvLibrary, responsibilityRows, rowFacets, updateResponsibilityRows, type CvLibrary, type Employment, type EvidenceFacet } from "@christopher/core/cv";
import { saveCvLibrary } from "@/app/actions/cv";
import { cvJobReadiness, cvLibraryReadiness } from "@/lib/cv-ready";
import { mergeCvLibrary } from "@/lib/cv-library-merge";
import { addJobRow, archivedBlocks, editableEmployment, jobEntry, jobRows, openStoredLibrary, pendingRowKey, removeJob, removeJobRow, restoreBlock, restoreJob, setJobRows, tagRow, withArchivedEmployment } from "@/lib/cv-library-rows";
import { NO_EVIDENCE, evidenceByEntry, missingFacetLine, rowsMovedOn, untaggedFacets, type EvidencePrompt, type LibraryEvidence } from "@/lib/cv-library-evidence";
import { EmploymentHistoryTable } from "./EmploymentHistoryTable";
import { EvidenceSummary } from "./EvidenceScore";
import { LibraryRowTypeSelect } from "./LibraryRowTypeSelect";
import { buttonClass } from "@/components/Button";
import { inputClass, labelClass, selectClass } from "@/components/Field";

const input = inputClass;
const libraryTabs = [["intro", "Intro"], ["experience", "Experience"], ["education", "Education, skills and interests"]] as const;
type LibraryTab = typeof libraryTabs[number][0];
const empty: CvLibrary = { name: "", contact: "", profile: "", employment: [], structuredExperience: true, entries: [] };

/** The rejection this editor can recover from, rather than asking for the work to be retyped. */
const OBSOLETE = "The library changed. Reload before saving.";
const LEAVE = "You have unsaved Library changes. Leave this page and lose them?";
const clockOf = (at: Date) => at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
/** What a row is keyed by everywhere it is remembered: confirmations, types and reviews. */
const rowKey = (text: string) => responsibilityRows(text)[0] ?? "";

/** The value on the screen, as a file, so nothing typed is lost to a merge or a failed reload. */
function downloadLibrary(value: CvLibrary, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CvLibraryEditor({ library, version: storedVersion, evidence = NO_EVIDENCE, need = null, job = null }: {
  library: CvLibrary | null;
  version: number;
  /** What the stored library's evidence reviews say, as they stood when this page was rendered. */
  evidence?: LibraryEvidence;
  /** A requirement a CV could not evidence, quoted from the gap row that linked here. */
  need?: string | null;
  /** The employment record that gap was about, when the link named one. */
  job?: string | null;
}) {
  const [tab, setTab] = useState<LibraryTab>(need || job ? "experience" : "intro");
  const [importError, setImportError] = useState("");
  const [value, setValue] = useState(() => library ? openStoredLibrary(library) : empty);
  /**
   * The version this editor is writing over, and the value it was opened on.
   *
   * Both move on a successful save — deterministically, because `saveCvLibrary` only accepts the
   * version it was given and stores that plus one — so the editor survives the revalidation its
   * own save triggers instead of being rebuilt from the server with everything else reset.
   */
  const [version, setVersion] = useState(storedVersion);
  const [baseline, setBaseline] = useState(() => library ? openStoredLibrary(library) : empty);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [notice, setNotice] = useState("");
  const [focusRow, setFocusRow] = useState<{ job: string; index: number } | null>(null);
  const [needShown, setNeedShown] = useState(true);
  /**
   * The types a row added for a prompt is meant to serve, held against its position until there is
   * something to tag. Types are keyed by a row's exact text and an empty row has none.
   */
  const [pendingFacets, setPendingFacets] = useState<Record<string, EvidenceFacet[]>>({});
  const [state, action, pending] = useActionState(saveCvLibrary, { ok: true } as Awaited<ReturnType<typeof saveCvLibrary>>);
  const submitted = useRef<CvLibrary | null>(null);
  const opened = useRef(false);
  const serialised = useMemo(() => JSON.stringify(value), [value]);
  const baselineJson = useMemo(() => JSON.stringify(baseline), [baseline]);
  const dirty = serialised !== baselineJson;
  const readiness = useMemo(() => cvLibraryReadiness(value), [value]);
  /**
   * The jobs on the screen: employment history minus the ones that were removed.
   *
   * A removed job keeps its record in the stored library, because the evidence archived with it
   * has to point at something; neither the record nor the rows are shown again anywhere but the
   * Archived jobs disclosure, which is the way back from the removal.
   */
  const jobs = useMemo(() => editableEmployment(value), [value]);
  /**
   * What was removed and can be put back: the jobs archived with their rows, and any block the
   * release before this one archived with its own control. Empty for almost everybody, and the
   * disclosure that lists it is rendered only when it is not.
   */
  const archived = useMemo(() => archivedBlocks(value), [value]);
  const scores = useMemo(() => evidenceByEntry(evidence), [evidence]);

  // What the form posted, for the moment it lands. `onSubmit` records it; this is the belt for
  // that brace, because a version left behind by a save makes the *next* save look obsolete.
  useEffect(() => {
    if (pending && !submitted.current) submitted.current = value;
  }, [pending, value]);

  // A save that landed: what was sent is now stored, one version on from what it replaced.
  useEffect(() => {
    if (!state.ok || !submitted.current) return;
    setBaseline(submitted.current);
    setVersion(current => current + 1);
    setSavedAt(new Date());
    setNotice("");
    submitted.current = null;
  }, [state]);

  // What the server last sent, whenever it differs from what this editor is holding: a save of its
  // own that retained an archived block, or a version stored from another tab. Taken only when
  // there is nothing on the screen to lose; while there is, the save says so and offers the merge,
  // which is the one path that keeps both.
  useEffect(() => {
    if (dirty) return;
    const stored = library ? openStoredLibrary(library) : empty;
    if (JSON.stringify(stored) === baselineJson) return;
    setValue(stored);
    setBaseline(stored);
    setVersion(storedVersion);
  }, [library, storedVersion, dirty, baselineJson]);

  /**
   * Arriving from a CV's evidence gap: open the job the gap was about with an empty row waiting
   * and the caret in it, so the answer can be typed straight in. Once only — a refresh from the
   * evidence poller must not add a second row underneath what is being written.
   */
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const target = editableEmployment(value).find(item => item.id === job);
    if (!target) return;
    setTab("experience");
    // A row already waiting to be typed into is the row to use; anything else gets a new one.
    const existing = jobRows(value, target.id);
    const last = existing.length - 1;
    if (existing.length && !(existing[last] ?? "").trim()) return setFocusRow({ job: target.id, index: last });
    const added = addJobRow(value, target);
    setValue(added.library);
    setFocusRow({ job: target.id, index: added.index });
    // `value` is read once, on mount, which is exactly what this effect is for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  /**
   * Nothing typed here leaves the page by accident: the browser's own prompt for a reload or a
   * close, and a confirm for the sidebar and every other in-app link, which the App Router gives
   * no way to intercept otherwise.
   */
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const intercept = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      let url: URL;
      try { url = new URL(anchor.href, window.location.href); } catch { return; }
      // A fragment on this page is not a navigation, and neither is a download or another origin.
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      if (window.confirm(LEAVE)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", intercept, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", intercept, true);
    };
  }, [dirty]);

  // A row added by the button is a row to type in, so the caret goes there.
  useEffect(() => {
    if (!focusRow) return;
    document.getElementById(`responsibility-${focusRow.job}-${focusRow.index}`)?.focus();
    setFocusRow(null);
  }, [focusRow]);

  /**
   * Reload the stored library and re-apply what is on the screen where the two do not collide,
   * rather than asking for it to be retyped. Anything the stored version had already changed is
   * named, and the value as it stands is downloaded so none of it depends on this merge.
   */
  async function reloadAndKeep() {
    try {
      const response = await fetch("/api/cv/library", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("unreadable");
      const stored = await response.json() as { version: number; content: unknown };
      const latest = stored.content ? openStoredLibrary(stored.content) : empty;
      const merged = mergeCvLibrary(baseline, value, latest, stored.version);
      if (merged.dropped.length) downloadLibrary(value, `cv-library-v${version}-yours.json`);
      setValue(merged.library);
      setBaseline(latest);
      setVersion(stored.version);
      setNotice(merged.note);
    } catch {
      downloadLibrary(value, `cv-library-v${version}-yours.json`);
      setNotice("Could not read the saved library. Your version has been downloaded as JSON; reload this page and import it to carry your text back in.");
    }
  }

  function revealInvalidField(event: FormEvent<HTMLDivElement>, panel: LibraryTab) {
    event.preventDefault();
    flushSync(() => setTab(panel));
    (event.target as HTMLElement).focus();
  }

  /** Add an empty row to a job, put the caret in it, and remember the type it is meant to serve. */
  function addRowFor(target: Employment, facet: EvidenceFacet | null) {
    const added = addJobRow(value, target);
    setValue(added.library);
    setFocusRow({ job: target.id, index: added.index });
    if (facet) setPendingFacets(current => ({ ...current, [pendingRowKey(target.id, added.index)]: [facet] }));
  }

  /**
   * One row's text as it is typed. The types promised by the prompt that asked for the row are
   * applied as soon as there is text to key them to; core carries them across every later edit.
   */
  function writeRow(target: Employment, rows: string[], index: number, text: string) {
    const next = rows.map((row, position) => position === index ? text.replace(/\r?\n/g, " ") : row);
    let updated = setJobRows(value, target, next);
    const key = pendingRowKey(target.id, index);
    const promised = pendingFacets[key];
    const written = rowKey(next[index] ?? "");
    if (promised?.length && written) {
      const entry = jobEntry(updated, target.id);
      if (entry) updated = tagRow(updated, entry.id, written, promised);
      setPendingFacets(current => {
        const rest = { ...current };
        delete rest[key];
        return rest;
      });
    }
    setValue(updated);
  }

  function field(key: "name" | "contact" | "profile", label: string, rows = 1) {
    return <label className="block space-y-1.5 text-14"><span className={labelClass}>{label}</span><textarea rows={rows} className={`resize-y ${input}`} value={value[key] ?? ""} onChange={e => setValue({ ...value, [key]: e.target.value })} /></label>;
  }
  const obsolete = !state.ok && state.error === OBSOLETE;
  const asked = (need ?? "").trim();
  return <form action={action} onSubmit={() => { submitted.current = value; }} className="min-w-0 space-y-4 pb-4">
    {/* A gap in a CV's evidence, carried here from the row that named it. Client state only: it is
        a note about the visit, not a thing to store. */}
    {asked && needShown && <div role="status" className="flex flex-wrap items-start justify-between gap-3 border-2 border-line bg-sunken p-3 text-14">
      <span>Add evidence for: {asked}</span>
      <button type="button" className="text-12 underline" onClick={() => setNeedShown(false)}>Dismiss</button>
    </div>}
    <div className="flex flex-wrap items-center gap-3 text-14">
      <label className="flex flex-wrap items-center gap-2"><span className={labelClass}>Import library JSON</span><input type="file" accept="application/json,.json" className="ds-pixel max-w-full text-10 file:mr-2 file:cursor-pointer file:border-2 file:border-line file:bg-raised file:px-2.5 file:py-1 file:text-10 file:text-fg hover:file:bg-fg hover:file:text-bg" onChange={async e => {
        const file = e.target.files?.[0]; if (!file) return;
        try { if (file.size > 150000) throw new Error("Library file is too large"); setValue(normaliseCvLibrary(JSON.parse(await file.text()))); setImportError(""); }
        catch { setImportError("Could not import this library JSON. Check its format and size."); }
        e.target.value = "";
      }} /></label>
      <button type="button" className="underline" onClick={() => downloadLibrary(value, "cv-library.json")}>Export library</button>
    </div>
    {importError && <p role="alert" className="text-danger">{importError}</p>}
    {/* What a CV can be built from today, by the rule generation itself applies. */}
    <p className={`text-14 ${readiness.ready ? "text-ok" : "text-warn"}`} role="status">{readiness.line}</p>
    {/* How well evidenced the whole history is, and how many jobs are holding it back. */}
    {evidence.line && <p className="text-14" role="status">{evidence.line}</p>}
    <input type="hidden" name="library" value={serialised} /><input type="hidden" name="version" value={version} />
    <div role="tablist" aria-label="Library sections" className="flex gap-2 border-b border-line-muted">
      {libraryTabs.map(([id, label]) => <button
        key={id} type="button" role="tab" id={`library-tab-${id}`} aria-controls={`library-panel-${id}`}
        aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
        className={`ds-pixel border-b-2 px-4 py-3 text-11 ${tab === id ? 'border-line text-fg' : 'border-transparent text-muted hover:text-fg'}`}
        onClick={() => setTab(id)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const index = libraryTabs.findIndex(([key]) => key === id);
          const next = libraryTabs[event.key === 'Home' ? 0 : event.key === 'End' ? libraryTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + libraryTabs.length) % libraryTabs.length]![0];
          setTab(next);
          document.getElementById(`library-tab-${next}`)?.focus();
        }}>{label}</button>)}
    </div>
    <div role="tabpanel" id="library-panel-intro" aria-labelledby="library-tab-intro" hidden={tab !== 'intro'} className="space-y-4" onInvalidCapture={event => revealInvalidField(event, 'intro')}>
    {field("name", "Name")}
    <label className="block space-y-1.5 text-14"><span className={labelClass}>LinkedIn</span><input type="url" className={input} value={value.linkedinUrl ?? ""} placeholder="https://www.linkedin.com/in/your-profile" onChange={e => setValue({ ...value, linkedinUrl: e.target.value })} /></label>
    <label className="block space-y-1.5 text-14"><span className={labelClass}>Website</span><input type="url" className={input} value={value.websiteUrl ?? ""} placeholder="https://example.com" onChange={e => setValue({ ...value, websiteUrl: e.target.value })} /></label>
    {field("contact", "Contact details")}{field("profile", "Career overview", 4)}
    </div>
    <div role="tabpanel" id="library-panel-experience" aria-labelledby="library-tab-experience" hidden={tab !== 'experience'} className="space-y-4" onInvalidCapture={event => revealInvalidField(event, 'experience')}>
    <EmploymentHistoryTable
      employment={jobs}
      entries={value.entries}
      onChange={employment => setValue({ ...value, employment: withArchivedEmployment(value, employment) })}
      onRemove={removed => { setPendingFacets({}); setValue(removeJob(value, removed.id)); }}
    />
    <h2 className="ds-pixel text-12">Experience</h2>
    {employmentCompanyGroups(jobs).map(group => <section key={group.company.toLowerCase()} className="space-y-3">
      <h3 className="text-16 font-semibold">{group.company || "New company"}</h3>
      {group.jobs.map(currentJob => {
        const entry = jobEntry(value, currentJob.id);
        const rows = jobRows(value, currentJob.id);
        const ready = cvJobReadiness(value, currentJob.id);
        const score = entry ? scores.get(entry.id) : undefined;
        // What the six types say is missing, live from the tags on screen. Shown on its own only
        // when it is not already the line the stored review carries.
        const untagged = entry ? missingFacetLine(untaggedFacets(entry)) : "";
        return <fieldset key={currentJob.id} className="min-w-0 space-y-3 border-2 border-line-muted p-4">
          <legend className="px-1 text-14 font-semibold">{employmentHeading(currentJob) || "Complete this job in employment history"}</legend>
          <p className="text-12 text-muted">Responsibilities and outcomes · {rows.length}/20</p>
          {/* What this job still needs before a CV can use it, and one control that supplies it. */}
          <p className={`flex flex-wrap items-center gap-3 text-12 ${ready.eligible ? "text-muted" : "text-warn"}`}>
            <span>{ready.line}</span>
            {entry && ready.rows > ready.confirmed && <button type="button" className="underline" onClick={() => setValue({ ...value, entries: value.entries.map(item => item.id === entry.id ? { ...item, confirmedResponsibilities: responsibilityRows(item.details) } : item) })}>Confirm all</button>}
          </p>
          {entry && score && <EvidenceSummary
            evidence={score}
            refusal={evidence.refusal}
            stale={rowsMovedOn(entry, score.reviewedRows)}
            onAddRow={(prompt: EvidencePrompt) => addRowFor(currentJob, prompt.facet)}
          />}
          {entry && untagged && untagged !== score?.missingLine && <p className="text-12 text-muted">{untagged}</p>}
          {rows.length > 20 && <p role="alert" className="text-14 text-warn">All existing wording has been preserved. Combine related rows to reach 20 or fewer before saving.</p>}
          {rows.length > 0 && <p className="text-12 text-muted sm:hidden">Scroll across the table for row types and row actions.</p>}
          {rows.length > 0 && <div className="relative overflow-x-auto border-2 border-line"><table className="w-full min-w-[820px] text-left text-14" aria-label={`${currentJob.company} ${currentJob.jobTitle} responsibilities and outcomes`}>
            <thead className="ds-pixel bg-sunken text-9 tracking-th text-muted"><tr><th scope="col" className="w-10 border-b-2 border-line px-3 py-2">#</th><th scope="col" className="w-28 border-b-2 border-line px-3 py-2 text-center">Confirmed</th><th scope="col" className="border-b-2 border-line px-3 py-2">Narrative</th><th scope="col" className="w-60 border-b-2 border-line px-3 py-2">Type</th><th scope="col" className="w-20 border-b-2 border-line px-3 py-2"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{rows.map((row, index) => {
              const key = rowKey(row);
              // What this row is for: what it is tagged with once there is text to key a tag to,
              // and until then what the prompt that asked for the row promised it would be.
              const facets = entry && key ? rowFacets(entry, key) : pendingFacets[pendingRowKey(currentJob.id, index)] ?? [];
              return <tr key={index} className="border-t border-line-faint align-top">
              <th scope="row" className="px-3 py-2 pt-4 font-normal text-muted">{index + 1}</th>
              <td className="px-3 py-2 pt-4 text-center"><input type="checkbox" aria-label={`Confirm ${currentJob.company} ${currentJob.jobTitle} entry ${index + 1}`} disabled={!row.trim()} checked={entry?.confirmedResponsibilities?.includes(key) ?? false} onChange={event => {
                  if (!entry || !key) return;
                  const confirmed = new Set(entry.confirmedResponsibilities ?? []);
                  if (event.target.checked) confirmed.add(key); else confirmed.delete(key);
                  setValue({ ...value, entries: value.entries.map(item => item.id === entry.id ? { ...item, confirmedResponsibilities: [...confirmed] } : item) });
                }} /></td>
              <td className="px-3 py-2">
                <textarea required rows={2} id={`responsibility-${currentJob.id}-${index}`} className={`resize-y ${input}`} placeholder={facets[0] ? EVIDENCE_FACET_PROMPTS[facets[0]] : undefined} aria-label={`${currentJob.company} ${currentJob.jobTitle} evidence ${index + 1}`} value={row} onChange={event => writeRow(currentJob, rows, index, event.target.value)} />
              </td>
              <td className="px-3 py-2">
                <LibraryRowTypeSelect
                  label={`Type of row ${index + 1}`}
                  value={facets}
                  onChange={next => {
                    if (entry && key) setValue(tagRow(value, entry.id, key, next));
                    else setPendingFacets(current => {
                      const rest = { ...current };
                      if (next.length) rest[pendingRowKey(currentJob.id, index)] = next; else delete rest[pendingRowKey(currentJob.id, index)];
                      return rest;
                    });
                  }}
                />
              </td>
              <td className="px-3 py-2">
                {/* The row goes and its tags go with it. The last row leaves an empty one to write
                    in: a job keeps its evidence block until the job itself is removed. */}
                <button type="button" className="min-h-11 text-12 text-muted underline hover:text-fg" aria-label={`Remove ${currentJob.company} ${currentJob.jobTitle} evidence ${index + 1}`} onClick={() => {
                    setPendingFacets({});
                    setValue(removeJobRow(value, currentJob, index));
                  }}>Remove</button>
              </td>
            </tr>;
            })}</tbody>
          </table></div>}
          <button type="button" className="text-14 underline disabled:opacity-40" disabled={rows.length >= 20} onClick={() => addRowFor(currentJob, null)}>Add new responsibility or outcome</button>
        </fieldset>;
      })}
    </section>)}
    {/* The way back from a removal — and from the "Archive block" control the release before this
        one offered, whose blocks would otherwise be stored where nothing on the screen could reach
        them. Not a status control: it is invisible until something has been archived, and what it
        puts back is unsaved like every other edit until the library is saved. */}
    {archived.length > 0 && <details className="border-2 border-line-muted px-3 py-2">
      <summary className="cursor-pointer text-12 text-muted">{`Archived jobs (${archived.length})`}</summary>
      <div className="mt-2 space-y-3 border-t-2 border-line-faint pt-2">
        <p className="text-12 text-muted">Removing a job archives its rows rather than deleting them. Restoring one puts it back in employment history with its rows, tags and confirmations; save the library to keep it.</p>
        <ul className="space-y-2">{archived.map(block => <li key={block.entryId} className="flex flex-wrap items-center justify-between gap-3 text-14">
          {/* One string, so the heading and its row count are one line of text wherever this is
              read: on the page, by a screen reader, and by the smoke script. */}
          <span>{block.rows === null ? block.heading : `${block.heading} · ${block.rows} ${block.rows === 1 ? "row" : "rows"}`}</span>
          <button type="button" className="min-h-11 text-12 text-muted underline hover:text-fg" aria-label={`Restore ${block.heading}`} onClick={() => {
            setValue(block.employmentId ? restoreJob(value, block.employmentId) : restoreBlock(value, block.entryId));
          }}>Restore</button>
        </li>)}</ul>
      </div>
    </details>}
    </div>
    <div role="tabpanel" id="library-panel-education" aria-labelledby="library-tab-education" hidden={tab !== 'education'} className="space-y-4" onInvalidCapture={event => revealInvalidField(event, 'education')}>
    <h2 className="ds-pixel text-12">Education, skills and interests</h2>
    {value.entries.map((entry, i) => entry.kind === "experience" || !isActiveEvidence(entry) ? null : <fieldset key={entry.id} className="space-y-3 border-2 border-line-muted p-4">
      <legend className="px-1 text-14 font-semibold">Evidence {i + 1}</legend>
      <label className="grid gap-1.5"><span className={labelClass}>Type</span><select aria-label={`Evidence ${i + 1} type`} className={selectClass} value={entry.kind} onChange={e => setValue({ ...value, entries: value.entries.map((x, n) => n === i ? { ...x, kind: e.target.value as typeof entry.kind, skillItems: e.target.value === "skill" ? x.skillItems : undefined, employmentId: undefined } : x) })}>{["education", "skill", "interest"].map(kind => <option key={kind}>{kind}</option>)}</select></label>
      <label className="grid gap-1.5"><span className={labelClass}>Evidence label (for example: AI governance programme)</span><input required className={input} value={entry.heading} onChange={e => setValue({ ...value, entries: value.entries.map((x, n) => n === i ? { ...x, heading: e.target.value } : x) })} /></label>
      {entry.kind === "skill" && <label className="grid gap-1.5"><span className={labelClass}>Individual skills — one per line</span><textarea rows={4} className={input} aria-label={`Individual skills: ${entry.heading}`} onBlur={() => setValue(current => ({ ...current, entries: current.entries.map(item => item.id === entry.id ? { ...item, skillItems: item.skillItems?.map(skill => skill.trim()).filter(Boolean).length ? item.skillItems.map(skill => skill.trim()).filter(Boolean) : undefined } : item) }))} value={entry.skillItems?.join("\n") ?? ""} onChange={e => setValue({ ...value, entries: value.entries.map((x, n) => n === i ? { ...x, skillItems: e.target.value ? e.target.value.split("\n") : undefined } : x) })} />
        <span className="block text-12 text-muted">Up to 20 skills, 80 characters each. Enter labels explicitly; existing prose is not split automatically. Leave blank to retain prose rendering. The supporting details below remain evidence.</span>
      </label>}
      <label className="grid gap-1.5"><span className={labelClass}>Details</span><textarea required rows={5} className={input} value={entry.details} onChange={e => setValue({ ...value, entries: value.entries.map((x, n) => n === i ? { ...x, details: e.target.value } : x) })} /></label>
      <div className="flex gap-3">
      <button type="button" disabled={i === 0} className="text-14 underline disabled:opacity-40" onClick={() => { const entries = [...value.entries]; [entries[i - 1], entries[i]] = [entries[i]!, entries[i - 1]!]; setValue({ ...value, entries }); }}>Move up</button>
      <button type="button" disabled={i === value.entries.length - 1} className="text-14 underline disabled:opacity-40" onClick={() => { const entries = [...value.entries]; [entries[i], entries[i + 1]] = [entries[i + 1]!, entries[i]!]; setValue({ ...value, entries }); }}>Move down</button>
      </div>
    </fieldset>)}
    <button type="button" className="mr-4 text-14 underline" onClick={() => setValue({ ...value, entries: [...value.entries, { id: crypto.randomUUID(), kind: "skill", status: "active", heading: "", details: "" }] })}>Add education, skill or interest</button>
    </div>
    {/* The save, and the one sentence that says whether anything is at stake, kept in view however
        far down the page the editing is. */}
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t-2 border-line bg-raised px-3 py-3">
      <button disabled={pending} className={buttonClass("primary")}>{pending ? "Saving…" : "Save library"}</button>
      {/* The stored version, as text rather than only the hidden input the save posts. */}
      <span className="text-12 text-muted">Version {version}</span>
      <span className="text-12 text-muted" aria-live="polite">
        {dirty ? "Unsaved changes" : savedAt ? `Saved ${clockOf(savedAt)}` : version ? "Saved" : "Not saved yet"}
      </span>
      {!state.ok && <span role="alert" className="text-14 text-danger">{state.error}</span>}
      {obsolete && <button type="button" className={buttonClass("secondary")} onClick={reloadAndKeep}>Reload and keep my text</button>}
      {notice && <span role="status" className="text-12 text-muted">{notice}</span>}
    </div>
  </form>;
}
