"use client";
import { startTransition, useActionState, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { EVIDENCE_FACET_PROMPTS, employmentHeading, isActiveEvidence, responsibilityRows, rowFacets, updateEmploymentIndustries, type EvidenceFacet } from "@col/core/cv-helpers";
import type { CvLibrary, Employment } from "@col/core/cv";
import { rescoreLibrary, saveCvLibrary } from "@/app/actions/cv";
import { cvJobReadiness, cvLibraryReadiness } from "@/lib/cv-ready";
import type { OpenedCvLibrary } from "@/lib/cv-library-open";
import type { CvLibraryConflict } from "@/lib/cv-library-merge";
import { addJobRow, archivedBlocks, editableEmployment, jobEntry, jobRows, pendingRowKey, removeJob, removeJobRow, restoreBlock, restoreJob, setJobRows, tagRow } from "@/lib/cv-library-rows";
import { NO_EVIDENCE, evidenceByEntry, missingFacetLine, rowGuidance, rowsMovedOn, untaggedFacets, type EvidencePrompt, type LibraryEvidence } from "@/lib/cv-library-evidence";
import { jobRemovalConfirm } from "./EmploymentHistoryTable";
import type { EvidenceDraftView } from "@/app/actions/evidence";
import { useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { EvidenceSummary } from "./EvidenceScore";
import { LibraryRowTypeMenu } from "./LibraryRowTypeMenu";
import { RowScoreButton } from "./RowScoreButton";
import { EvidenceGuide } from "./EvidenceGuide";
import { buttonClass } from "@/components/Button";
import { inputClass, labelClass, selectClass } from "@/components/Field";
import { CV_LIMITS, cvSkillCharacterState } from "@col/core/cv-format";
import { editedCvSkillEntryIds, normaliseSubmittedLibrarySkills, parseCvSkillList, splitCvLibrarySkillItem } from "@/lib/cv-skill-list";

const input = inputClass;
const EvidenceConversation = dynamic(() => import("./EvidenceConversation").then(module => module.EvidenceConversation),
  { loading: () => <p className="text-14 text-muted">Opening question…</p> });
const libraryTabs = [["experience", "Work history"], ["education", "Education & skills"], ["intro", "About you"]] as const;
type LibraryTab = typeof libraryTabs[number][0];
const empty: CvLibrary = { name: "", contact: "", profile: "", employment: [], structuredExperience: true, entries: [] };

/** The rejection this editor can recover from, rather than asking for the work to be retyped. */
const OBSOLETE = "The library changed. Reload before saving.";
const LEAVE = "Leave and lose your unsaved Experience changes?";
const DISCARD = "Discard your unsaved Experience changes?";
const clockOf = (at: Date) => at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
/** What a row is keyed by everywhere it is remembered: confirmations, types and reviews. */
const rowKey = (text: string) => responsibilityRows(text)[0] ?? "";
type ConflictChoice = "mine" | "stored";
type Recovery = {
  original: CvLibrary;
  base: CvLibrary;
  latest: CvLibrary;
  version: number;
  conflicts: CvLibraryConflict[];
  choices: Record<string, ConflictChoice>;
  valid: boolean;
};
const conflictText = (value: unknown) => value === null ? "Removed in your draft" : typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "(empty)";

export function CvLibraryEditor({ library, version: storedVersion, evidence = NO_EVIDENCE, need = null, job = null, openDrafts = [], returnTo = null, scopeId }: {
  /** Opened on the server (`openStoredLibrary`); the type is how that is required. */
  library: OpenedCvLibrary | null;
  version: number;
  /** What the stored library's evidence reviews say, as they stood when this page was rendered. */
  evidence?: LibraryEvidence;
  /** A requirement a CV could not evidence, quoted from the gap row that linked here. */
  need?: string | null;
  /** The employment record that gap was about, when the link named one. */
  job?: string | null;
  openDrafts?: EvidenceDraftView[];
  returnTo?: string | null;
  scopeId: string;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<LibraryTab>("experience");
  // `library` arrives opened: the page ran `openStoredLibrary` on it in the same request (see
  // app/(app)/library/page.tsx), and opening is idempotent, so it is held as sent rather than
  // parsed again here — which would put the CV schema and zod in this page's first load.
  const [value, setValue] = useState<CvLibrary>(() => library ?? empty);
  /**
   * The version this editor is writing over, and the value it was opened on.
   *
   * Both move on a successful save — deterministically, because `saveCvLibrary` only accepts the
   * version it was given and stores that plus one — so the editor survives the revalidation its
   * own save triggers instead of being rebuilt from the server with everything else reset.
   */
  const [version, setVersion] = useState(storedVersion);
  const [baseline, setBaseline] = useState<CvLibrary>(() => library ?? empty);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [notice, setNotice] = useState("");
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [copyMessage, setCopyMessage] = useState("");
  const [focusRow, setFocusRow] = useState<{ job: string; index: number } | null>(null);
  const [needShown, setNeedShown] = useState(true);
  const [lastRemovedEmpty, setLastRemovedEmpty] = useState<Employment | null>(null);
  const [questionFor, setQuestionFor] = useState<Record<string, EvidenceFacet | null>>({});
  const [selectedJobId, setSelectedJobId] = useState<string | null>(() => {
    const visible = editableEmployment(library ?? empty);
    return visible.some(item => item.id === job) ? job : visible[0]?.id ?? null;
  });
  const [detailsJobId, setDetailsJobId] = useState<string | null>(storedVersion === 0 ? (job ?? library?.employment?.[0]?.id ?? null) : null);
  /**
   * The types a row added for a prompt is meant to serve, held against its position until there is
   * something to tag. Types are keyed by a row's exact text and an empty row has none.
   */
  const [pendingFacets, setPendingFacets] = useState<Record<string, EvidenceFacet[]>>({});
  const [state, action, pending] = useActionState(saveCvLibrary, { ok: true } as Awaited<ReturnType<typeof saveCvLibrary>>);
  const [rescoreState, rescore, rescoring] = useActionState(rescoreLibrary, { ok: true } as Awaited<ReturnType<typeof rescoreLibrary>>);
  const submitted = useRef<CvLibrary | null>(null);
  const submittedVersion = useRef<number | null>(null);
  const recoveryRef = useRef<Recovery | null>(null);
  const recoveryHeading = useRef<HTMLHeadingElement | null>(null);
  const recoveryFocused = useRef(false);
  const choiceRevision = useRef(0);
  const opened = useRef(false);
  const serialised = useMemo(() => JSON.stringify(value), [value]);
  const baselineJson = useMemo(() => JSON.stringify(baseline), [baseline]);
  const dirty = serialised !== baselineJson;
  const editedSkillIds = editedCvSkillEntryIds(value, baseline);
  const parsedSkillItems = (entry: CvLibrary["entries"][number]) => parseCvSkillList(
    (entry.skillItems ?? []).join("\n"), baseline.entries.find(item => item.id === entry.id)?.skillItems ?? [],
  );
  const invalidSkills = value.entries.some(entry => {
    if (entry.kind !== "skill" || !isActiveEvidence(entry)) return false;
    const items = parsedSkillItems(entry);
    return items.length > 20 || items.some(item => cvSkillCharacterState(item).tooLong);
  });
  const unresolved = recovery?.conflicts.filter(conflict => !recovery.choices[conflict.key]).length ?? 0;
  const recoveryPending = !!recovery && (unresolved > 0 || !recovery.valid);
  const readiness = useMemo(() => cvLibraryReadiness(value), [value]);
  /**
   * The jobs on the screen: employment history minus the ones that were removed.
   *
   * A removed job keeps its record in the stored library, because the evidence archived with it
   * has to point at something; neither the record nor the rows are shown again anywhere but the
   * Archived jobs disclosure, which is the way back from the removal.
   */
  const jobs = useMemo(() => editableEmployment(value), [value]);
  useEffect(() => {
    if (job && jobs.some(item => item.id === job)) { setSelectedJobId(job); return; }
    try {
      const remembered = window.sessionStorage.getItem(`experience-selected:${scopeId}`);
      if (remembered && jobs.some(item => item.id === remembered)) setSelectedJobId(remembered);
    } catch { /* The first job remains selected. */ }
  // The remembered selection is read once on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeId]);
  useEffect(() => {
    if (selectedJobId && !jobs.some(item => item.id === selectedJobId)) setSelectedJobId(jobs[0]?.id ?? null);
  }, [jobs, selectedJobId]);
  function selectJob(id: string) {
    setSelectedJobId(id);
    try { window.sessionStorage.setItem(`experience-selected:${scopeId}`, id); } catch { /* This visit still keeps the selection. */ }
  }
  /**
   * What was removed and can be put back: the jobs archived with their rows, and any block the
   * release before this one archived with its own control. Empty for almost everybody, and the
   * disclosure that lists it is rendered only when it is not.
   */
  const archived = useMemo(() => archivedBlocks(value), [value]);
  const scores = useMemo(() => evidenceByEntry(evidence), [evidence]);
  /**
   * Whether the saved rows have changed since they were last reviewed: an entry no stored review
   * describes in its saved wording is scored provisionally, from the person's own tags, until the
   * review runs. That is read from the reviews themselves, keyed by each entry's input hash, so it
   * survives a reload and says nothing about a save that changed only the intro. Offered only while
   * nothing is on the screen to save and no pass is already running.
   */
  // Offered for any entry the model has not scored, not only one whose rows changed: a pass the
  // budget refused, or the model left unread, holds a rules-only row, and a save no longer queues
  // the next pass on its own. Asking again is cheap; a refused pass returns before any model call.
  const changedRows = evidence.entries.some(entry => entry.provisional);
  const unreviewed = version > 0 && !evidence.evaluating && evidence.entries.some(entry => entry.provisional || entry.source !== "model");

  // The reload control disappears when its result becomes a conflict review. Put keyboard
  // focus at the new section once, so Tab reaches Download and the choices rather than
  // restarting at the page navigation. Re-rendering a choice must not steal focus back.
  useEffect(() => {
    if (!recovery) { recoveryFocused.current = false; return; }
    if (recoveryFocused.current) return;
    recoveryHeading.current?.focus();
    recoveryFocused.current = true;
  }, [recovery]);

  // What the form posted, for the moment it lands. `onSubmit` records it; this is the belt for
  // that brace, because a version left behind by a save makes the *next* save look obsolete.
  useEffect(() => {
    if (pending && !submitted.current) { submitted.current = value; submittedVersion.current = version; }
  }, [pending, value, version]);

  // A save that landed: what was sent is now stored, one version on from what it replaced.
  useEffect(() => {
    if (!state.ok || !submitted.current) return;
    setBaseline(submitted.current);
    setVersion(current => current + 1);
    setSavedAt(new Date());
    setNotice("");
    setRecovery(null);
    setDetailsJobId(null);
    recoveryRef.current = null;
    choiceRevision.current++;
    submitted.current = null;
  }, [state]);

  // What the server last sent, whenever it differs from what this editor is holding: a save of its
  // own that retained an archived block, or a version stored from another tab. Taken only when
  // there is nothing on the screen to lose; while there is, the save says so and offers the merge,
  // which is the one path that keeps both.
  useEffect(() => {
    if (dirty || recovery) return;
    const stored = library ?? empty;
    if (JSON.stringify(stored) === baselineJson) return;
    setValue(stored);
    setBaseline(stored);
    setVersion(storedVersion);
  }, [library, storedVersion, dirty, baselineJson, recovery]);

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    if (job) setTab("experience");
  }, [job]);

  /**
   * Nothing typed here leaves the page by accident: the browser's own prompt for a reload or a
   * close, and a confirm for the sidebar and every other in-app link, which the App Router gives
   * no way to intercept otherwise.
   */
  useEffect(() => {
    if (!dirty && !recovery) return;
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
  }, [dirty, recovery]);

  // A row added by the button is a row to type in, so the caret goes there.
  useEffect(() => {
    if (!focusRow) return;
    const field = document.getElementById(`responsibility-${focusRow.job}-${focusRow.index}`);
    field?.closest("details")?.setAttribute("open", "");
    field?.focus();
    setFocusRow(null);
  }, [focusRow]);

  /**
   * Reload the stored library and re-apply what is on the screen where the two do not collide,
   * rather than asking for it to be retyped. Anything the stored version had already changed is
   * named, and the stored version wins it; everything else stays on the screen, unsaved.
   */
  async function reloadAndKeep() {
    try {
      const response = await fetch("/api/cv/library", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("unreadable");
      // Opened by the route before it was sent, exactly as the page opens what it renders.
      const stored = await response.json() as { version: number; content: OpenedCvLibrary | null };
      const latest = stored.content ?? empty;
      // The merge validates its result with the CV schema, so it is loaded only when a reload
      // actually runs rather than with the page.
      const { mergeCvLibrary } = await import("@/lib/cv-library-merge");
      const merged = mergeCvLibrary(baseline, value, latest, stored.version);
      const nextRecovery = { original: value, base: baseline, latest, version: stored.version, conflicts: merged.conflicts, choices: {}, valid: merged.valid };
      recoveryRef.current = nextRecovery;
      choiceRevision.current++;
      setRecovery(nextRecovery);
      setValue(merged.library);
      setBaseline(latest);
      setVersion(stored.version);
      setNotice(merged.note);
    } catch {
      setNotice("Could not read saved Experience. Your text is still here; try again.");
    }
  }

  /** A conflict is changed only after the person sees both versions and chooses one. */
  async function chooseConflict(key: string, choice: ConflictChoice) {
    const current = recoveryRef.current;
    if (!current) return;
    const choices = { ...current.choices, [key]: choice };
    const next = { ...current, choices };
    recoveryRef.current = next;
    const revision = ++choiceRevision.current;
    setRecovery(next);
    const { mergeCvLibrary } = await import("@/lib/cv-library-merge");
    const preferred = new Set(Object.entries(choices).filter(([, value]) => value === "mine").map(([id]) => id));
    const merged = mergeCvLibrary(next.base, next.original, next.latest, next.version, preferred);
    if (revision !== choiceRevision.current) return;
    const resolved = { ...next, valid: merged.valid };
    recoveryRef.current = resolved;
    setRecovery(resolved);
    if (merged.valid) setValue(merged.library);
    setNotice(merged.note);
  }

  /** The exact local document before the reload remains available even if a merge is impossible. */
  function downloadOriginal() {
    if (!recovery) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(recovery.original, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `col-library-unsaved-v${recovery.version - 1}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setCopyMessage("Original draft downloaded. Keep it until this Experience is saved.");
  }

  async function copyOriginal() {
    if (!recovery) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(recovery.original, null, 2));
      setCopyMessage("Original draft copied. Keep it until this Experience is saved.");
    } catch {
      setCopyMessage("Clipboard unavailable. Open the original draft below and copy its text, or download it.");
    }
  }

  function revealInvalidField(event: FormEvent<HTMLDivElement>, panel: LibraryTab) {
    event.preventDefault();
    const jobId = (event.target as HTMLElement).closest<HTMLElement>("[data-job-id]")?.dataset.jobId;
    flushSync(() => { setTab(panel); if (jobId) { selectJob(jobId); setDetailsJobId(jobId); } });
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

  /** One line of the intro: every one of them the same control, at the same height. */
  function line(key: "name" | "email" | "phone" | "location" | "contact" | "linkedinUrl" | "websiteUrl", label: string, props: { type?: string; placeholder?: string; autoComplete?: string } = {}) {
    return <label className="block min-w-0 space-y-1.5 text-14"><span className={labelClass}>{label}</span><input required={key === "name"} type={props.type ?? "text"} className={input} value={value[key] ?? ""} placeholder={props.placeholder} autoComplete={props.autoComplete} onChange={e => setValue({ ...value, [key]: e.target.value })} /></label>;
  }

  /** Put back the library as it was last saved, after asking: this is the one control that loses typing. */
  function discard() {
    if (!window.confirm(DISCARD)) return;
    setValue(baseline);
    setRecovery(null);
    recoveryRef.current = null;
    choiceRevision.current++;
    setPendingFacets({});
    setNotice("");
  }
  // Once the newer version has been loaded, the prior refusal is history. Only a refusal of the
  // version currently held should offer another reload or appear beside its Save control.
  const currentRefusal = !state.ok && submittedVersion.current === version;
  const obsolete = currentRefusal && state.error === OBSOLETE && !recovery;
  const asked = (need ?? "").trim();
  // The bar at the top of the editor is there only when there is something to do in it: changes to
  // save, the saved rows to re-score, or a sentence about either.
  // A refusal is shown only while there is still something to re-score; a later pass clears it.
  const refused = !rescoreState.ok && (unreviewed || rescoring) ? rescoreState.error : "";
  const bar = dirty || unreviewed || rescoring || !!notice || !!refused || !!recovery;
  return <form action={action} onSubmit={event => {
    if (recoveryPending || invalidSkills) { event.preventDefault(); return; }
    const incomplete = editableEmployment(value).find(item => !item.company.trim() || !item.jobTitle.trim());
    if (incomplete) {
      event.preventDefault();
      setTab("experience"); selectJob(incomplete.id); setDetailsJobId(incomplete.id);
      window.setTimeout(() => document.getElementById(`job-content-${incomplete.id}`)?.querySelector<HTMLInputElement>("input[required]:invalid")?.focus(), 0);
      return;
    }
    const normalised = normaliseSubmittedLibrarySkills(value, editedSkillIds, baseline) as CvLibrary;
    // The hidden JSON field must reflect the normalised labels in this very submit event, even
    // when Save is clicked before the textarea has blurred.
    flushSync(() => setValue(normalised));
    submitted.current = normalised;
    submittedVersion.current = version;
  }} className="min-w-0 space-y-4 pb-4">
    {/* Saving is only ever the person's own act, so the control that does it is pinned above the
        fold as soon as there is anything to save, and gone when there is not. Once a save has
        changed rows, the same place offers the re-score — never automatic, because it spends the
        account's AI budget. */}
    {(dirty || !!notice || !!recovery) && <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b-2 border-line bg-bg py-3">
      {dirty && <>
        <span className="text-14 font-semibold" aria-live="polite">Unsaved changes</span>
        <button disabled={pending || recoveryPending || invalidSkills} className={buttonClass("primary")}>{pending ? "Saving…" : "Save Experience"}</button>
        <button type="button" disabled={pending} className={buttonClass("ghost")} onClick={discard}>Discard</button>
        {currentRefusal && !recovery && <span role="alert" className="text-14 text-danger">{state.error}</span>}
        {obsolete && <button type="button" className={buttonClass("secondary")} onClick={reloadAndKeep}>Reload and keep my text</button>}
      </>}
      {notice && <span role="status" className="text-12 text-muted">{notice}</span>}
    </div>}
    {recovery && <section className="space-y-3 border-2 border-warn p-4" aria-labelledby="library-recovery-title">
      <h2 id="library-recovery-title" ref={recoveryHeading} tabIndex={-1} className="text-16 font-semibold scroll-mt-32 focus:outline-2 focus:outline-offset-2 focus:outline-line">Keep your original Experience draft</h2>
      <p className="text-14">Your complete local draft from before the reload is still here. Download or copy it, then choose the wording for each conflict. The latest saved version stays unchanged until you press Save Experience.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass("secondary")} onClick={downloadOriginal}>Download original draft</button>
        <button type="button" className={buttonClass("ghost")} onClick={() => void copyOriginal()}>Copy original draft</button>
      </div>
      {copyMessage && <p role="status" className="text-12 text-muted">{copyMessage}</p>}
      <details><summary className="cursor-pointer text-12 underline">Show original draft text</summary><textarea readOnly aria-label="Original unsaved Experience draft" className={`mt-2 w-full ${input}`} rows={8} value={JSON.stringify(recovery.original, null, 2)} /></details>
      {recovery.conflicts.map(conflict => <div key={conflict.key} className="space-y-2 border-t border-line-muted pt-3">
        <h3 className="text-14 font-semibold">{conflict.label}</h3>
        <div className="grid gap-2 md:grid-cols-2">
          <div><p className="text-12 font-semibold">Your unsaved version</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words border border-line-muted p-2 text-12">{conflictText(conflict.mine)}</pre></div>
          <div><p className="text-12 font-semibold">Latest saved version</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words border border-line-muted p-2 text-12">{conflictText(conflict.stored)}</pre></div>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label={`Choose wording for ${conflict.label}`}>
          <button type="button" aria-pressed={recovery.choices[conflict.key] === "mine"} className={buttonClass(recovery.choices[conflict.key] === "mine" ? "primary" : "secondary")} onClick={() => void chooseConflict(conflict.key, "mine")}>Use my version</button>
          <button type="button" aria-pressed={recovery.choices[conflict.key] === "stored"} className={buttonClass(recovery.choices[conflict.key] === "stored" ? "primary" : "secondary")} onClick={() => void chooseConflict(conflict.key, "stored")}>Keep saved version</button>
        </div>
      </div>)}
      {unresolved > 0 && <p role="status" className="text-12 text-warn">Choose wording for {unresolved} {unresolved === 1 ? "conflict" : "conflicts"} before saving.</p>}
      {unresolved === 0 && recovery.valid && !dirty && <button type="button" className={buttonClass("secondary")} onClick={() => { recoveryRef.current = null; choiceRevision.current++; setRecovery(null); }}>Finish review</button>}
      {!recovery.valid && <div className="space-y-2"><p role="alert" className="text-12 text-danger">These versions cannot be combined into valid Experience automatically. Your original draft remains above. Save a copy, then reapply its wording in the editor.</p><button type="button" className={buttonClass("secondary")} onClick={() => { if (window.confirm("Have you copied or downloaded your original draft? The editor will continue from the latest saved Experience.")) { setValue(recovery.latest); setBaseline(recovery.latest); setVersion(recovery.version); recoveryRef.current = null; choiceRevision.current++; setRecovery(null); setNotice(""); } }}>Continue editing from saved version</button></div>}
    </section>}
    {/* A save that changed nothing to re-score leaves no bar behind; this says it landed. */}
    <span className="sr-only" aria-live="polite">{!dirty && savedAt ? `Saved ${clockOf(savedAt)}` : ""}</span>
    {/* A gap in a CV's evidence, carried here from the row that named it. Client state only: it is
        a note about the visit, not a thing to store. */}
    {asked && needShown && <div role="status" className="flex flex-wrap items-start justify-between gap-3 border-2 border-line bg-sunken p-3 text-14">
      <span>Add evidence for: {asked}</span>
      {returnTo && <Link href={returnTo} className="text-12 underline">Return to CV</Link>}
      <button type="button" className="text-12 underline" onClick={() => setNeedShown(false)}>Dismiss</button>
    </div>}
    {/* What a CV can be built from today, by the rule generation itself applies. */}
    <p className={`text-14 ${readiness.ready ? "text-muted" : "text-warn"}`} role="status">{readiness.ready ? "Your confirmed evidence can be used in future CVs." : readiness.line.replace(/^Ready to build: no — /, "To build a CV, ")}</p>
    <input type="hidden" name="library" value={serialised} /><input type="hidden" name="version" value={version} /><input type="hidden" name="editedSkillIds" value={JSON.stringify(editedSkillIds)} />
    <div role="tablist" aria-label="Experience sections" className="flex flex-wrap gap-x-2 border-b border-line-muted">
      {libraryTabs.map(([id, label]) => <button
        key={id} type="button" role="tab" id={`library-tab-${id}`} aria-controls={`library-panel-${id}`}
        aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
        className={`border-b-2 px-4 py-3 text-14 font-semibold ${tab === id ? 'border-line text-fg' : 'border-transparent text-muted hover:text-fg'}`}
        onClick={() => setTab(id)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const index = libraryTabs.findIndex(([key]) => key === id);
          const next = libraryTabs[event.key === 'Home' ? 0 : event.key === 'End' ? libraryTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + libraryTabs.length) % libraryTabs.length]![0];
          setTab(next);
          document.getElementById(`library-tab-${next}`)?.focus();
        }}>{label}</button>)}
    </div>
    <fieldset disabled={recoveryPending} className="min-w-0 space-y-4">
    <div role="tabpanel" id="library-panel-intro" aria-labelledby="library-tab-intro" hidden={tab !== 'intro'} className="space-y-4" onInvalidCapture={event => revealInvalidField(event, 'intro')}>
    {line("name", "Name", { autoComplete: "name" })}
    {/* The three details a CV header prints, in the order it prints them: email · phone · location. */}
    <div className="grid gap-4 sm:grid-cols-3">
      {line("email", "Email", { type: "email", autoComplete: "email", placeholder: "name@example.com" })}
      {line("phone", "Phone", { type: "tel", autoComplete: "tel", placeholder: "+44 7700 900123" })}
      {line("location", "Location", { autoComplete: "address-level2", placeholder: "Manchester, UK" })}
    </div>
    {line("linkedinUrl", "LinkedIn", { type: "url", placeholder: "https://www.linkedin.com/in/your-profile" })}
    {line("websiteUrl", "Website", { type: "url", placeholder: "https://example.com" })}
    {/* Whatever else the header should carry. A library saved when contact details were one line
        keeps everything that was not an email address or a phone number here. */}
    {line("contact", "Other contact details", { placeholder: "e.g. right to work" })}
    <label className="block space-y-1.5 text-14"><span className={labelClass}>Bio</span>
      <textarea rows={4} className={`resize-y ${input}`} value={value.profile ?? ""} placeholder="Who you are and the work you do." onChange={e => setValue({ ...value, profile: e.target.value })} />
    </label>
    </div>
    <div role="tabpanel" id="library-panel-experience" aria-labelledby="library-tab-experience" hidden={tab !== 'experience'} className="space-y-4" onInvalidCapture={event => revealInvalidField(event, 'experience')}>
    <div className="space-y-2">
      <h2 className="ds-pixel text-12">Work history</h2>
      <p className="ds-prose text-14 text-muted">Keep the job details together with the work you can describe. Answer a question to review a draft, or edit rows directly.</p>
      {version === 0 && <p className="text-14 text-muted">Add your name in About you and save your first job. Then you can answer a question to add evidence.</p>}
      <button type="button" className={buttonClass("secondary")} onClick={() => { const id = crypto.randomUUID(); setValue(current => ({ ...current, employment: [...(current.employment ?? []), { id, company: "", jobTitle: "", startDate: "", endDate: "", current: false }] })); selectJob(id); setDetailsJobId(id); }}>Add job</button>
      {lastRemovedEmpty && <button type="button" className="ml-3 text-14 underline" onClick={() => { setValue(current => ({ ...current, employment: [...(current.employment ?? []), lastRemovedEmpty] })); selectJob(lastRemovedEmpty.id); setDetailsJobId(lastRemovedEmpty.id); setLastRemovedEmpty(null); }}>Restore last removed job</button>}
    </div>
    {jobs.map(currentJob => {
        const entry = jobEntry(value, currentJob.id);
        const rows = jobRows(value, currentJob.id);
        const ready = cvJobReadiness(value, currentJob.id);
        const score = entry ? scores.get(entry.id) : undefined;
        const jobNumber = jobs.findIndex(item => item.id === currentJob.id) + 1;
        const confirmedFacets = new Set((entry?.confirmedResponsibilities ?? []).flatMap(row => rowFacets(entry!, row)));
        const nextQuestion = !confirmedFacets.has("outcome") ? "outcome" : !confirmedFacets.has("problem") ? "problem" : null;
        const activeQuestion = questionFor[currentJob.id] ?? nextQuestion;
        // What the six types say is missing, live from the tags on screen. Shown on its own only
        // when it is not already the line the stored review carries.
        const untagged = entry ? missingFacetLine(untaggedFacets(entry)) : "";
        const selected = selectedJobId === currentJob.id || (selectedJobId === null && jobNumber === 1);
        return <section key={currentJob.id} data-job-id={currentJob.id} className="min-w-0 border-2 border-line-muted">
          <button type="button" aria-expanded={selected} aria-controls={`job-content-${currentJob.id}`} className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left hover:bg-sunken" onClick={() => selectJob(currentJob.id)}>
            <span className="text-16 font-semibold">{employmentHeading(currentJob) || "New job"}</span>
            <span className="text-12 text-muted">{ready.rows ? `${ready.confirmed} of ${ready.rows} confirmed` : "No evidence yet"} · {selected ? "Open" : "View job"}</span>
          </button>
          {selected && <div id={`job-content-${currentJob.id}`} className="space-y-4 border-t border-line-muted px-4 py-4">
          <details open={detailsJobId === currentJob.id} onToggle={event => { if (event.currentTarget.open) setDetailsJobId(currentJob.id); else if (detailsJobId === currentJob.id) setDetailsJobId(null); }} className="border-b border-line-muted pb-3"><summary className="cursor-pointer text-14 text-muted">Edit job details</summary><div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1"><span className={labelClass}>Company</span><input aria-label={`Job ${jobNumber} company`} required maxLength={160} className={input} value={currentJob.company} onChange={e => setValue(current => ({ ...current, employment: (current.employment ?? []).map(item => item.id === currentJob.id ? { ...item, company: e.target.value } : item) }))} /></label>
            <label className="space-y-1"><span className={labelClass}>Job title</span><input aria-label={`Job ${jobNumber} title`} required maxLength={160} className={input} value={currentJob.jobTitle} onChange={e => setValue(current => ({ ...current, employment: (current.employment ?? []).map(item => item.id === currentJob.id ? { ...item, jobTitle: e.target.value } : item) }))} /></label>
            <label className="space-y-1"><span className={labelClass}>Start date</span><input aria-label={`Job ${jobNumber} start date`} placeholder="YYYY-MM" pattern="[0-9]{4}(-[0-9]{2})?" className={input} value={currentJob.startDate} onChange={e => setValue(current => ({ ...current, employment: (current.employment ?? []).map(item => item.id === currentJob.id ? { ...item, startDate: e.target.value } : item) }))} /></label>
            <label className="space-y-1"><span className={labelClass}>End date</span><input aria-label={`Job ${jobNumber} end date`} placeholder={currentJob.current ? "Present" : "YYYY-MM"} disabled={currentJob.current} pattern="[0-9]{4}(-[0-9]{2})?" className={input} value={currentJob.endDate} onChange={e => setValue(current => ({ ...current, employment: (current.employment ?? []).map(item => item.id === currentJob.id ? { ...item, endDate: e.target.value } : item) }))} /></label>
            <label className="flex items-center gap-2 text-14"><input aria-label={`Job ${jobNumber} current`} type="checkbox" checked={currentJob.current} onChange={e => setValue(current => ({ ...current, employment: (current.employment ?? []).map(item => item.id === currentJob.id ? { ...item, current: e.target.checked, endDate: e.target.checked ? "" : item.endDate } : item) }))} />Current job</label>
          </div>
          <details><summary className="cursor-pointer text-12 text-muted">Industry descriptions</summary><textarea aria-label={`${currentJob.company} ${currentJob.jobTitle} industry descriptions`} rows={2} maxLength={1200} className={`mt-2 ${input}`} value={currentJob.industryDescriptions ?? ""} onChange={e => setValue(current => ({ ...current, employment: updateEmploymentIndustries(current.employment ?? [], currentJob.id, e.target.value) }))} /></details>
          <button type="button" title="Remove job" aria-label={`Remove ${currentJob.company} ${currentJob.jobTitle}`} className="text-12 text-muted underline" onClick={() => { if (rows.length && !window.confirm(jobRemovalConfirm(currentJob, rows.length))) return; if (!rows.length) setLastRemovedEmpty(currentJob); setPendingFacets({}); setValue(removeJob(value, currentJob.id)); selectJob(jobs.find(item => item.id !== currentJob.id)?.id ?? ""); }}>Remove job</button>
          </div></details>
          {rows.length > 0 && <div className="space-y-2"><p className="text-12 font-semibold">What you did and achieved</p><ul className="list-disc space-y-2 pl-5 ds-prose text-16">{rows.filter(Boolean).map((row, index) => <li key={`${index}-${row}`}>{row}</li>)}</ul></div>}
          {/* What this job still needs before a CV can use it, and one control that supplies it. */}
          {entry && ready.rows > ready.confirmed && <p className="flex flex-wrap items-center gap-3 text-12 text-warn"><span>{ready.line}</span><button type="button" className="underline" onClick={() => setValue({ ...value, entries: value.entries.map(item => item.id === entry.id ? { ...item, confirmedResponsibilities: responsibilityRows(item.details) } : item) })}>Confirm all</button></p>}
          <div className="flex flex-wrap gap-3 text-14"><button type="button" className="underline" aria-pressed={activeQuestion === "outcome"} onClick={() => setQuestionFor(current => ({ ...current, [currentJob.id]: "outcome" }))}>Describe a result</button><button type="button" className="underline" aria-pressed={activeQuestion === "problem"} onClick={() => setQuestionFor(current => ({ ...current, [currentJob.id]: "problem" }))}>Describe how you worked</button></div>
          {activeQuestion ? <EvidenceConversation key={`${currentJob.id}:${activeQuestion}:${version}`} question={activeQuestion === "problem" ? "What challenge did you face in this job, and how did you work through it?" : activeQuestion === "outcome" ? "What result did your work produce in this job, and what did you do to help achieve it?" : EVIDENCE_FACET_PROMPTS[activeQuestion]} questionId={`job:${currentJob.id}:${activeQuestion}`} destination={{ kind: "employment", id: currentJob.id }} destinationLabel={`${currentJob.jobTitle} at ${currentJob.company}`} scopeId={scopeId} baseVersion={version} source="library" facet={activeQuestion} disabled={dirty || pending} initialDraft={openDrafts.find(item => item.destination.kind === "employment" && item.destination.id === currentJob.id && item.questionId === `job:${currentJob.id}:${activeQuestion}` && item.baseVersion === version)} onConfirmed={() => { setQuestionFor(current => ({ ...current, [currentJob.id]: null })); setNotice("Evidence saved to Experience."); router.refresh(); }} /> : <p role="status" className="ds-prose text-14 text-muted">Done for now. Your result and way of working are both covered. You can add another example whenever you like.</p>}
          {dirty && <p className="text-12 text-muted">Save the job details before answering a question.</p>}
          <details className="border-t border-line-muted pt-3"><summary className="cursor-pointer text-12 text-muted">Evidence guide and scores</summary>
          {entry && score && <EvidenceSummary
            evidence={score}
            refusal={evidence.refusal}
            stale={rowsMovedOn(entry, score.reviewedRows)}
            onAddRow={(prompt: EvidencePrompt) => setQuestionFor(current => ({ ...current, [currentJob.id]: prompt.facet ?? "outcome" }))}
          />}
          {entry && untagged && untagged !== score?.missingLine && <p className="text-12 text-muted">{untagged}</p>}
          </details>
          <details className="border-t border-line-muted pt-3"><summary className="cursor-pointer text-12 text-muted">Edit evidence rows directly · {rows.length}/20</summary>
          {rows.length > 20 && <p role="alert" className="text-14 text-warn">Combine rows to 20 or fewer before saving.</p>}
          {rows.length > 0 && <div className="relative md:overflow-x-auto md:border-2 md:border-line"><table className="block w-full text-left text-14 md:table md:min-w-[820px]" aria-label={`${currentJob.company} ${currentJob.jobTitle} responsibilities and outcomes`}>
            <thead className="hidden bg-sunken text-9 text-muted md:table-header-group"><tr><th scope="col" className="ds-pixel tracking-th w-10 border-b-2 border-line px-3 py-2">#</th><th scope="col" className="ds-pixel tracking-th w-20 border-b-2 border-line px-3 py-2 text-center">Confirmed</th><th scope="col" className="ds-pixel tracking-th border-b-2 border-line px-3 py-2">Narrative</th><th scope="col" className="ds-pixel tracking-th w-44 border-b-2 border-line px-3 py-2">Type</th><th scope="col" className="ds-pixel tracking-th w-32 border-b-2 border-line px-3 py-2">Score</th><th scope="col" className="ds-pixel tracking-th w-20 border-b-2 border-line px-3 py-2"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody className="block space-y-3 md:table-row-group md:space-y-0">{rows.map((row, index) => {
              const key = rowKey(row);
              // What this row is for: what it is tagged with once there is text to key a tag to,
              // and until then what the prompt that asked for the row promised it would be.
              const facets = entry && key ? rowFacets(entry, key) : pendingFacets[pendingRowKey(currentJob.id, index)] ?? [];
              // This row as the review of the saved library read it. Its marks stand only while the
              // row on the screen is the row that was saved; otherwise the wording is read live.
              const rowScore = key ? score?.rows.find(item => item.row === key) : undefined;
              // One path for a row's types, whether they come from the Type menu or are the full
              // review's reading adopted from the score panel.
              const setFacets = (next: EvidenceFacet[]) => {
                if (entry && key) setValue(tagRow(value, entry.id, key, next));
                else setPendingFacets(current => {
                  const rest = { ...current };
                  if (next.length) rest[pendingRowKey(currentJob.id, index)] = next; else delete rest[pendingRowKey(currentJob.id, index)];
                  return rest;
                });
              };
              return <tr key={index} className="block min-w-0 border-2 border-line-muted p-2 align-top md:table-row md:border-x-0 md:border-t md:border-b-0 md:border-line-faint md:p-0">
              <th scope="row" className="block px-3 py-2 font-semibold text-muted md:table-cell md:pt-4 md:font-normal"><span className="md:hidden">Row </span>{index + 1}</th>
              <td className="block px-3 py-2 md:table-cell md:pt-4 md:text-center"><label className="flex items-center gap-2 md:justify-center"><input type="checkbox" aria-label={`Confirm ${currentJob.company} ${currentJob.jobTitle} entry ${index + 1}`} disabled={!row.trim()} checked={entry?.confirmedResponsibilities?.includes(key) ?? false} onChange={event => {
                  if (!entry || !key) return;
                  const confirmed = new Set(entry.confirmedResponsibilities ?? []);
                  if (event.target.checked) confirmed.add(key); else confirmed.delete(key);
                  setValue({ ...value, entries: value.entries.map(item => item.id === entry.id ? { ...item, confirmedResponsibilities: [...confirmed] } : item) });
                }} /><span className="text-12 md:hidden">Confirmed</span></label></td>
              <td className="block px-3 py-2 md:table-cell"><span className="mb-1 block text-12 font-semibold md:hidden">Narrative</span>
                <textarea required rows={2} id={`responsibility-${currentJob.id}-${index}`} className={`block min-h-16 resize-y ${input}`} placeholder={facets[0] ? EVIDENCE_FACET_PROMPTS[facets[0]] : undefined} aria-label={`${currentJob.company} ${currentJob.jobTitle} evidence ${index + 1}`} value={row} onChange={event => writeRow(currentJob, rows, index, event.target.value)} />
              </td>
              {/* One pixel tall so the menu's trigger, at full height, stretches with the row. */}
              <td className="block px-3 py-2 md:table-cell md:h-px"><span className="mb-1 block text-12 font-semibold md:hidden">Type</span>
                <LibraryRowTypeMenu
                  label={`Type of row ${index + 1}`}
                  value={facets}
                  onChange={setFacets}
                />
              </td>
              <td className="block px-3 py-2 md:table-cell"><span className="mb-1 block text-12 font-semibold md:hidden">Score</span>
                <RowScoreButton index={index + 1} guidance={rowGuidance({ text: key, facets, view: rowScore, source: score?.source ?? "rules", evaluating: !!score?.evaluating })} onAdopt={setFacets} />
              </td>
              <td className="block px-3 py-2 md:table-cell">
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
          </details>
          </div>}
        </section>;
      })}
    {/* The way back from a removal — and from the "Archive block" control the release before this
        one offered, whose blocks would otherwise be stored where nothing on the screen could reach
        them. Not a status control: it is invisible until something has been archived, and what it
        puts back is unsaved like every other edit until the library is saved. */}
    {archived.length > 0 && <details className="border-2 border-line-muted px-3 py-2">
      <summary className="cursor-pointer text-12 text-muted">{`Archived jobs (${archived.length})`}</summary>
      <div className="mt-2 space-y-3 border-t-2 border-line-faint pt-2">
        <p className="text-12 text-muted">A restore is unsaved; save Experience to keep it.</p>
        <ul className="space-y-2">{archived.map(block => <li key={block.entryId} className="flex flex-wrap items-center justify-between gap-3 text-14">
          {/* One string, so the heading and its row count are one line of text wherever this is
              read: on the page, by a screen reader, and by the smoke script. */}
          <span>{block.rows === null ? block.heading : `${block.heading} · ${block.rows} ${block.rows === 1 ? "row" : "rows"}`}</span>
          <button type="button" className="min-h-11 text-12 text-muted underline hover:text-fg" aria-label={`Restore ${block.heading}`} onClick={() => {
            setValue(block.employmentId ? restoreJob(value, block.employmentId) : restoreBlock(value, block.entryId));
            if (block.employmentId) selectJob(block.employmentId);
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
      <label className="grid gap-1.5"><span className={labelClass}>Evidence label</span><input required placeholder="e.g. AI governance programme" className={input} value={entry.heading} onChange={e => setValue({ ...value, entries: value.entries.map((x, n) => n === i ? { ...x, heading: e.target.value } : x) })} /></label>
      {entry.kind === "skill" && (() => {
        const parsed = parsedSkillItems(entry);
        return <><label className="grid gap-1.5"><span className={labelClass}>Individual skills</span><textarea rows={4} className={input} aria-label={`Individual skills: ${entry.heading}`} onBlur={() => setValue(current => {
          if (!editedCvSkillEntryIds(current, baseline).includes(entry.id)) return current;
          return normaliseSubmittedLibrarySkills(current, [entry.id], baseline) as CvLibrary;
        })} value={entry.skillItems?.join("\n") ?? ""} onChange={e => setValue({ ...value, entries: value.entries.map((x, n) => n === i ? { ...x, skillItems: e.target.value ? e.target.value.split("\n") : undefined } : x) })} />
          <span className="block text-12 text-muted">These are compact CV skill pills, up to {CV_LIMITS.skillCharacters} characters each. Separate them with commas, semicolons or new lines. Use Details below for supporting context.</span>
          <span className="block text-12 text-muted">New CV builds use your latest saved Experience. Existing drafts keep the version they started with.</span>
          <span className={`block text-12 ${parsed.length > 20 ? "text-danger" : "text-muted"}`} aria-live="polite">{parsed.length}/20 individual skills</span>
          {parsed.length > 0 && <span className="block text-12 text-muted">{parsed.map((item, index) => <span key={`${index}-${item}`} className="block">{item} — {cvSkillCharacterState(item).count}/{CV_LIMITS.skillCharacters} characters</span>)}</span>}
          {parsed.map((item, index) => cvSkillCharacterState(item).tooLong
            ? <span key={`error-${index}`} className="block text-12 text-danger" role="alert">Skill {index + 1} is {cvSkillCharacterState(item).count} characters; the limit is {CV_LIMITS.skillCharacters}. Move supporting detail to Details.</span>
            : cvSkillCharacterState(item).approaching
              ? <span key={`warning-${index}`} className="block text-12 text-warn" role="status">Skill {index + 1} is approaching {CV_LIMITS.skillCharacters} characters.</span>
              : null)}
          {parsed.length > 20 && <span className="block text-12 text-danger" role="alert">Keep up to 20 individual skills in this block.</span>}
        </label>
          {(entry.skillItems ?? []).map((item, itemIndex) => {
            const split = splitCvLibrarySkillItem(entry.skillItems ?? [], itemIndex);
            if (!split) return null;
            const overLimit = split.length > 20;
            return <div key={itemIndex} className="flex flex-wrap items-center gap-2 text-12">
              <span>Skill {itemIndex + 1}: {item}</span>
              <button type="button" className={buttonClass("secondary")} aria-label={`Split skill ${itemIndex + 1} in ${entry.heading} into separate skills`} disabled={overLimit} onClick={() => setValue(current => ({ ...current, entries: current.entries.map(candidate => {
                if (candidate.id !== entry.id) return candidate;
                const skillItems = splitCvLibrarySkillItem(candidate.skillItems ?? [], itemIndex);
                return skillItems ? { ...candidate, skillItems } : candidate;
              }) }))}>Split list into skills</button>
              {overLimit && <span className="text-danger" role="status">Splitting makes {split.length} skills; maximum 20. Remove some first.</span>}
            </div>;
          })}
        </>;
      })()}
      <label className="grid gap-1.5"><span className={labelClass}>Details</span><textarea required rows={5} className={input} value={entry.details} onChange={e => setValue({ ...value, entries: value.entries.map((x, n) => n === i ? { ...x, details: e.target.value } : x) })} />{entry.kind === "skill" && <span className="text-12 text-muted">Explain the scope of these skills. This supports matching and assessment; it is not printed beneath the skill pills. Put employer-specific examples and results in Experience.</span>}</label>
      <div className="flex gap-3">
      <button type="button" disabled={i === 0} className="text-14 underline disabled:opacity-40" onClick={() => { const entries = [...value.entries]; [entries[i - 1], entries[i]] = [entries[i]!, entries[i - 1]!]; setValue({ ...value, entries }); }}>Move up</button>
      <button type="button" disabled={i === value.entries.length - 1} className="text-14 underline disabled:opacity-40" onClick={() => { const entries = [...value.entries]; [entries[i], entries[i + 1]] = [entries[i + 1]!, entries[i]!]; setValue({ ...value, entries }); }}>Move down</button>
      </div>
    </fieldset>)}
    <button type="button" className="mr-4 text-14 underline" onClick={() => setValue({ ...value, entries: [...value.entries, { id: crypto.randomUUID(), kind: "skill", status: "active", heading: "", details: "" }] })}>Add education, skill or interest</button>
    </div>
    </fieldset>
    <details className="border-t border-line-muted pt-3"><summary className="cursor-pointer text-14 font-semibold">Review evidence</summary>
      <div className="mt-3 space-y-3">
        {evidence.line && <p className="text-14 text-muted">{evidence.line}</p>}
        {(unreviewed || rescoring) && <div className="flex flex-wrap items-center gap-3 text-14"><span>{changedRows ? "Some rows changed since the last review." : "Some rows have not been reviewed yet."}</span><button type="button" disabled={rescoring || dirty} className={buttonClass("secondary")} onClick={() => startTransition(() => rescore(new FormData()))}>{rescoring ? "Reviewing…" : "Re-score evidence"}</button></div>}
        {refused && <p role="alert" className="text-14 text-danger">{refused}</p>}
        <details><summary className="cursor-pointer text-12 text-muted">How evidence is scored</summary><div className="mt-3"><EvidenceGuide /></div></details>
      </div>
    </details>
  </form>;
}
