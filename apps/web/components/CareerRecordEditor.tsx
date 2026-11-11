"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CareerChange, CareerChangeResult, CareerOperation, CareerRecordFields,
  CareerRecordView, CareerWorkspace } from "@col/core/career-record";
import { saveCareerChange, undoCareerChange } from "@/app/actions/career";
import { buttonClass } from "./Button";
import { inputClass, labelClass, selectClass } from "./Field";
import { SkillTagPicker, skillKey } from "./SkillTagPicker";

type RecordKind = CareerRecordView["kind"];
const kinds: Array<[RecordKind, string]> = [
  ["role", "Work"], ["project", "Project"],
  ["contribution", "Contribution"], ["skill", "Skill"], ["learning", "Learning"],
  ["qualification", "Qualification"], ["engagement", "Client engagement"],
  ["organisation", "Organisation"], ["other", "Other activity"],
];
const commonKinds: RecordKind[] = ["role", "project", "learning", "qualification", "skill", "other"];
const advancedKinds: RecordKind[] = ["engagement", "organisation", "contribution"];
const arrangements: Array<[NonNullable<CareerRecordFields["arrangement"]>, string]> = [
  ["employment", "Employment"], ["contract", "Contract"], ["consultancy", "Consultancy"],
  ["fractional", "Fractional"], ["self_employed", "Self-employed"], ["voluntary", "Voluntary"], ["other", "Other"],
];
const relationships: Array<[Extract<CareerOperation, { type: "create_link" }>["kind"], string]> = [
  ["employed_by", "Employed by"], ["contracted_through", "Contracted through"],
  ["delivered_for", "Delivered for"], ["part_of", "Part of"],
  ["contributed_to", "Contributed to"], ["member_of", "Member of"],
];
const emptyFields = (title: string): CareerRecordFields => ({ title, originalNarrative: "",
  dates: { start: null, end: null, current: false }, arrangement: null, publicLabel: null, confidential: false,
  industries: [] });
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** A career fact saves once when editing leaves the field; the acknowledged change is its Undo. */
export function CareerRecordEditor({ workspace, initialQuery = "" }: { workspace: CareerWorkspace; initialQuery?: string }) {
  const router = useRouter();
  const [selected, setSelected] = useState(workspace.selected);
  const incomingSelected = workspace.selected;
  const [fields, setFields] = useState<CareerRecordFields>(() => selected?.record.fields ?? emptyFields(""));
  const [industriesText, setIndustriesText] = useState(() => (selected?.record.fields.industries ?? []).join(", "));
  const [savedFields, setSavedFields] = useState<CareerRecordFields>(() => selected?.record.fields ?? emptyFields(""));
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const savedRef = useRef(savedFields);
  savedRef.current = savedFields;
  const revisionRef = useRef(workspace.revision);
  const recordRevisionRef = useRef(selected?.record.revision ?? 0);
  const selectedIdRef = useRef(selected?.record.id ?? null);
  const assertionRevisionsRef = useRef<Record<string, number>>(Object.fromEntries(
    selected?.assertions.map(row => [row.id, row.revision]) ?? []));
  const assertionBaseRef = useRef<Record<string, { text: string; publicText: string }>>(Object.fromEntries(
    selected?.assertions.map(row => [row.id, { text: row.text, publicText: row.publicText ?? "" }]) ?? []));
  const busyRef = useRef(false);
  const queuedRecord = useRef(false);
  const queuedAssertion = useRef<(() => Promise<void>) | null>(null);
  const retryRef = useRef<(() => Promise<void>) | null>(null);
  const failedRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "unsaved" | "saving" | "saved" | "failed">("idle");
  const [error, setError] = useState("");
  const [lastChange, setLastChange] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<RecordKind>("role");
  const [newTitle, setNewTitle] = useState("");
  const [assertion, setAssertion] = useState("");
  const [publicAssertion, setPublicAssertion] = useState("");
  const [assertionEdits, setAssertionEdits] = useState<Record<string, string>>({});
  const [publicAssertionEdits, setPublicAssertionEdits] = useState<Record<string, string>>({});
  const assertionEditsRef = useRef(assertionEdits);
  assertionEditsRef.current = assertionEdits;
  const publicAssertionEditsRef = useRef(publicAssertionEdits);
  publicAssertionEditsRef.current = publicAssertionEdits;
  const [linkKind, setLinkKind] = useState<(typeof relationships)[number][0]>("part_of");
  const [linkTo, setLinkTo] = useState("");
  const [linkConfidential, setLinkConfidential] = useState(false);
  const [linkPublicLabel, setLinkPublicLabel] = useState("");
  const [perspectiveId, setPerspectiveId] = useState<string | null>(null);
  const [perspectiveLabel, setPerspectiveLabel] = useState("");
  const [perspectiveNote, setPerspectiveNote] = useState("");
  const [perspectiveAssertions, setPerspectiveAssertions] = useState<string[]>([]);
  const recordDirty = !same(fields, savedFields) || industriesText !== fields.industries.join(", ");
  const assertionDirty = selected?.assertions.some(row => {
    const saved = assertionBaseRef.current[row.id] ?? { text: row.text, publicText: row.publicText ?? "" };
    return (assertionEdits[row.id] ?? saved.text) !== saved.text ||
      (publicAssertionEdits[row.id] ?? saved.publicText) !== saved.publicText;
  }) ?? false;
  const draftDirty = !!(newTitle.trim() || assertion.trim() || publicAssertion.trim() || linkTo || linkPublicLabel.trim() ||
    perspectiveLabel.trim() || perspectiveNote.trim() || perspectiveAssertions.length);
  const dirty = recordDirty || assertionDirty || draftDirty;
  const otherDraftDirty = !!(assertion.trim() || publicAssertion.trim() || linkTo || linkPublicLabel.trim() ||
    perspectiveLabel.trim() || perspectiveNote.trim() || perspectiveAssertions.length);
  const sourceChanged = incomingSelected?.record.id !== selected?.record.id;

  useEffect(() => {
    if (!incomingSelected || dirty || busyRef.current) return;
    if (incomingSelected.record.id !== selectedIdRef.current) {
      selectedIdRef.current = incomingSelected.record.id;
      revisionRef.current = workspace.revision;
      recordRevisionRef.current = incomingSelected.record.revision;
      setSelected(incomingSelected);
      setFields(incomingSelected.record.fields); setSavedFields(incomingSelected.record.fields);
      setIndustriesText(incomingSelected.record.fields.industries.join(", "));
      assertionRevisionsRef.current = Object.fromEntries(incomingSelected.assertions.map(row => [row.id, row.revision]));
      assertionBaseRef.current = Object.fromEntries(incomingSelected.assertions.map(row =>
        [row.id, { text: row.text, publicText: row.publicText ?? "" }]));
      setAssertionEdits({}); setPublicAssertionEdits({}); setLastChange(null); setStatus("idle");
      return;
    }
    if (workspace.revision < revisionRef.current) return;
    revisionRef.current = workspace.revision;
    if (incomingSelected.record.revision < recordRevisionRef.current) return;
    recordRevisionRef.current = incomingSelected.record.revision;
    setSelected(incomingSelected);
    setFields(incomingSelected.record.fields); setSavedFields(incomingSelected.record.fields);
    setIndustriesText(incomingSelected.record.fields.industries.join(", "));
    assertionRevisionsRef.current = Object.fromEntries(incomingSelected.assertions.map(row => [row.id, row.revision]));
    assertionBaseRef.current = Object.fromEntries(incomingSelected.assertions.map(row =>
      [row.id, { text: row.text, publicText: row.publicText ?? "" }]));
    setAssertionEdits({}); setPublicAssertionEdits({});
  }, [workspace.revision, incomingSelected, dirty]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const intercept = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      let url: URL;
      try { url = new URL(anchor.href, window.location.href); } catch { return; }
      if (url.origin !== window.location.origin ||
        (url.pathname === window.location.pathname && url.search === window.location.search)) return;
      // Record links give a local recovery message without discarding this buffer.
      if (url.pathname === window.location.pathname && url.searchParams.has("record")) return;
      if (window.confirm("Leave Experience? Unsaved details will be lost.")) return;
      event.preventDefault(); event.stopPropagation();
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", intercept, true);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", intercept, true); };
  }, [dirty, busy]);

  async function run(change: CareerChange, after: (result: Extract<CareerChangeResult, { ok: true }>) => void) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setStatus("saving"); setError("");
    let saved = false;
    try {
      const result = await saveCareerChange(change);
      if (!result.ok) { failedRef.current = true; setStatus("failed"); setError(result.error); return; }
      saved = true; failedRef.current = false;
      revisionRef.current = result.revision;
      setLastChange(result.changeId); setStatus("saved"); retryRef.current = null;
      after(result); router.refresh();
    } catch { failedRef.current = true; setStatus("failed"); setError("Could not save this change. Your text remains here."); }
    finally {
      busyRef.current = false; setBusy(false);
      if (saved) {
        if (queuedRecord.current) { queuedRecord.current = false; window.queueMicrotask(() => void saveRecord()); }
        else if (queuedAssertion.current) { const next = queuedAssertion.current; queuedAssertion.current = null;
          window.queueMicrotask(() => void next()); }
      }
    }
  }
  async function saveRecord() {
    if (!selected || same(fieldsRef.current, savedRef.current)) return;
    if (busyRef.current) { queuedRecord.current = true; return; }
    if (failedRef.current) return;
    const submitted = fieldsRef.current;
    const change: CareerChange = { expectedRevision: revisionRef.current, requestKey: crypto.randomUUID(),
      operations: [{ type: "edit_record", id: selected.record.id,
        expectedRevision: recordRevisionRef.current, fields: submitted }] };
    const attempt = async () => run(change, () => {
      recordRevisionRef.current++;
      savedRef.current = submitted; setSavedFields(submitted);
      if (!same(fieldsRef.current, submitted)) queuedRecord.current = true;
    });
    retryRef.current = attempt;
    await attempt();
  }
  function changeFields(next: CareerRecordFields) { setFields(next); fieldsRef.current = next; setStatus("unsaved"); }
  async function makeRecord() {
    const title = newTitle.trim();
    if (!title || busyRef.current || recordDirty || assertionDirty || otherDraftDirty) return;
    const id = crypto.randomUUID();
    const change: CareerChange = { expectedRevision: revisionRef.current, requestKey: crypto.randomUUID(),
      operations: [{ type: "create_record", id, kind: newKind, fields: emptyFields(title) }] };
    const attempt = async () => run(change, () => { setNewTitle(""); router.push(`/library?record=${id}#career-record-${id}`); });
    retryRef.current = attempt; await attempt();
  }
  async function addAssertion(skillLabel?: string) {
    if (!selected || !(skillLabel ?? assertion).trim() || busyRef.current || recordDirty) return;
    const submitted = (skillLabel ?? assertion).trim();
    const change: CareerChange = { expectedRevision: revisionRef.current, requestKey: crypto.randomUUID(),
      operations: [{ type: "add_assertion", id: crypto.randomUUID(), subjectId: selected.record.id,
        text: submitted, publicText: publicAssertion.trim() || null,
        facets: selected.record.kind === "skill" ? ["skill"] : [], context: null }] };
    const attempt = async () => run(change, () => { if (skillLabel === undefined) { setAssertion(""); setPublicAssertion(""); } });
    retryRef.current = attempt; await attempt();
  }
  async function editAssertion(id: string, expectedRevision: number, original: string) {
    const row = selected?.assertions.find(item => item.id === id);
    const text = assertionEditsRef.current[id] ?? original;
    const publicText = publicAssertionEditsRef.current[id] ?? row?.publicText ?? "";
    if (!selected || !row || !text.trim() || recordDirty) return;
    if (busyRef.current) { queuedAssertion.current = () => editAssertion(id, expectedRevision, original); return; }
    if (failedRef.current) return;
    const saved = assertionBaseRef.current[id] ?? { text: original, publicText: row.publicText ?? "" };
    if (text === saved.text && publicText === saved.publicText) return;
    const submittedText = text.trim();
    const submittedPublicText = publicText.trim();
    const change: CareerChange = { expectedRevision: revisionRef.current, requestKey: crypto.randomUUID(),
      operations: [{ type: "edit_assertion", id, expectedRevision: assertionRevisionsRef.current[id] ?? expectedRevision, text: submittedText,
        publicText: submittedPublicText || null,
        facets: row.facets, context: row.context }] };
    const attempt = async () => run(change, () => { assertionRevisionsRef.current[id] = (assertionRevisionsRef.current[id] ?? expectedRevision) + 1;
      assertionBaseRef.current[id] = { text: submittedText, publicText: submittedPublicText };
      setAssertionEdits(current => current[id] === text ? { ...current, [id]: submittedText } : current);
      setPublicAssertionEdits(current => current[id] === publicText ? { ...current, [id]: submittedPublicText } : current);
      if ((assertionEditsRef.current[id] ?? row.text) !== text || (publicAssertionEditsRef.current[id] ?? row.publicText ?? "") !== publicText)
        queuedAssertion.current = () => editAssertion(id, expectedRevision, original);
    });
    retryRef.current = attempt; await attempt();
  }
  async function retractAssertion(id: string, expectedRevision: number, retracted: boolean) {
    if (busyRef.current || recordDirty || assertionDirty) return;
    const change: CareerChange = { expectedRevision: revisionRef.current, requestKey: crypto.randomUUID(),
      operations: [{ type: "retract_assertion", id,
        expectedRevision: assertionRevisionsRef.current[id] ?? expectedRevision, retracted }] };
    const attempt = async () => run(change, () => { assertionRevisionsRef.current[id] =
      (assertionRevisionsRef.current[id] ?? expectedRevision) + 1; });
    retryRef.current = attempt; await attempt();
  }
  async function changeArchive(archived: boolean) {
    if (!selected || busyRef.current || dirty) return;
    const change: CareerChange = { expectedRevision: revisionRef.current, requestKey: crypto.randomUUID(),
      operations: [{ type: "archive_record", id: selected.record.id,
        expectedRevision: recordRevisionRef.current, archived }] };
    const attempt = async () => run(change, () => { recordRevisionRef.current++; router.refresh(); });
    retryRef.current = attempt; await attempt();
  }
  async function addLink() {
    if (!selected || !linkTo || busyRef.current || recordDirty || assertionDirty) return;
    const change: CareerChange = { expectedRevision: revisionRef.current, requestKey: crypto.randomUUID(),
      operations: [{ type: "create_link", id: crypto.randomUUID(), fromId: selected.record.id,
        toId: linkTo, kind: linkKind, confidential: linkConfidential,
        publicLabel: linkConfidential ? linkPublicLabel.trim() || null : null }] };
    const attempt = async () => run(change, () => { setLinkTo(""); setLinkPublicLabel(""); setLinkConfidential(false); });
    retryRef.current = attempt; await attempt();
  }
  async function removeLink(id: string, expectedRevision: number) {
    if (busyRef.current || recordDirty || assertionDirty) return;
    const change: CareerChange = { expectedRevision: revisionRef.current, requestKey: crypto.randomUUID(),
      operations: [{ type: "remove_link", id, expectedRevision }] };
    const attempt = async () => run(change, () => {});
    retryRef.current = attempt; await attempt();
  }
  async function savePerspective() {
    if (!selected || !perspectiveLabel.trim() || busyRef.current || recordDirty || assertionDirty) return;
    const prior = selected.perspectives.find(row => row.id === perspectiveId);
    const change: CareerChange = { expectedRevision: revisionRef.current, requestKey: crypto.randomUUID(),
      operations: [{ type: "save_perspective", id: prior?.id ?? crypto.randomUUID(),
        expectedRevision: prior?.revision ?? 0, label: perspectiveLabel.trim(), note: perspectiveNote.trim(),
        assertionIds: perspectiveAssertions }] };
    const attempt = async () => run(change, () => { setPerspectiveId(null); setPerspectiveLabel("");
      setPerspectiveNote(""); setPerspectiveAssertions([]); });
    retryRef.current = attempt; await attempt();
  }
  async function removePerspective(id: string, expectedRevision: number) {
    if (busyRef.current || recordDirty || assertionDirty) return;
    const change: CareerChange = { expectedRevision: revisionRef.current, requestKey: crypto.randomUUID(),
      operations: [{ type: "remove_perspective", id, expectedRevision }] };
    const attempt = async () => run(change, () => { if (perspectiveId === id) { setPerspectiveId(null);
      setPerspectiveLabel(""); setPerspectiveNote(""); setPerspectiveAssertions([]); } });
    retryRef.current = attempt; await attempt();
  }
  async function undo(changeId: string) {
    if (busyRef.current || dirty) return;
    busyRef.current = true; setBusy(true); setStatus("saving"); setError("");
    try {
      const result = await undoCareerChange({ changeId, expectedRevision: revisionRef.current, requestKey: crypto.randomUUID() });
      if (!result.ok) { setStatus("failed"); setError(result.error); return; }
      revisionRef.current = result.revision; setStatus("saved"); setLastChange(null); router.refresh();
    } catch { setStatus("failed"); setError("Could not undo that change. Your saved work remains available."); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const shown = workspace.records;
  return <section aria-label="Career record" className="space-y-5">
    <div className="space-y-2"><h2 className="text-16 font-semibold">Your career record</h2>
      <p className="text-14 text-muted">Add roles, projects and useful details as you remember them. Your own facts are ready to use when saved; writing advice is optional.</p></div>
    <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void makeRecord(); }}>
      <label className="grid gap-1"><span className={labelClass}>Add</span><select className={selectClass} value={newKind}
        onChange={event => setNewKind(event.target.value as RecordKind)}>
        {advancedKinds.includes(newKind) && <option value={newKind}>{kinds.find(([kind]) => kind === newKind)?.[1]}</option>}
        {kinds.filter(([kind]) => commonKinds.includes(kind)).map(([value,label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label className="grid min-w-0 flex-1 gap-1"><span className={labelClass}>Name or title</span><input className={inputClass}
        maxLength={250} value={newTitle} onChange={event => setNewTitle(event.target.value)} placeholder="e.g. Programme delivery" /></label>
      <button className={buttonClass("primary")} disabled={busy || recordDirty || assertionDirty || otherDraftDirty || !newTitle.trim()}>Add to Experience</button>
    </form>
    <details className="text-13"><summary className="min-h-11 cursor-pointer text-muted">More record types</summary>
      <div className="flex flex-wrap gap-2">{kinds.filter(([kind]) => advancedKinds.includes(kind)).map(([kind,label]) =>
        <button type="button" key={kind} className="min-h-11 underline" onClick={() => setNewKind(kind)}>Add {label.toLowerCase()}</button>)}</div>
    </details>
    <div className="grid gap-5 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
      <nav aria-label="Career records" className="min-w-0 space-y-2"><h3 className="text-14 font-semibold">Browse your record</h3>
        <form method="get" action="/library" className="flex flex-wrap items-end gap-2"
          onSubmit={event => { if (dirty || busy) { event.preventDefault(); setError("Save or retry this detail before searching another record."); } }}>
          <label className="grid min-w-0 flex-1 gap-1 text-13">Find in Experience
            <input className={inputClass} name="query" maxLength={200} defaultValue={initialQuery} placeholder="Search titles" /></label>
          <button className={buttonClass("secondary")}>Find</button>
        </form>
        {shown.length === 0 ? <p className="text-14 text-muted">No career details saved yet. Start with a role, project or other activity.</p> :
          <ul className="divide-y divide-line-faint border-y border-line-faint">{shown.map(row =>
            <li key={row.id}><a className="block min-h-11 py-2 text-14 underline" aria-current={selected?.record.id === row.id ? "page" : undefined}
              href={`/library?record=${row.id}#career-record-${row.id}`}
              onClick={event => { if (dirty || busy) { event.preventDefault(); setError("Save or retry this detail before opening another record."); } }}>
              {row.title}{row.archived ? " · Archived" : ""}</a></li>)}</ul>}
        {workspace.nextCursor && <a className="inline-flex min-h-11 items-center text-13 underline"
          href={`/library?cursor=${encodeURIComponent(workspace.nextCursor)}${initialQuery ? `&query=${encodeURIComponent(initialQuery)}` : ""}`}
          onClick={event => { if (dirty || busy) { event.preventDefault(); setError("Save or retry this detail before opening older records."); } }}>
          Older records</a>}
      </nav>
      {selected ? <div id={`career-record-${selected.record.id}`} className="min-w-0 space-y-4 scroll-mt-20">
        {sourceChanged && <div role="alert" className="border border-warn p-3 text-13">
          <p>Another record was opened while this one still has unsaved text. Your work remains attached to {selected.record.fields.title}.</p>
              <a className="inline-flex min-h-11 items-center underline" href={`/library?record=${selected.record.id}#career-record-${selected.record.id}`}>
            Return to this record</a></div>}
        <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-12 text-muted">{kinds.find(([kind]) => kind === selected.record.kind)?.[1]}</p>
          <h3 className="text-16 font-semibold">{selected.record.fields.title}</h3></div>
          <button type="button" className={buttonClass("secondary")} disabled={busy || dirty}
            onClick={() => void changeArchive(!selected.record.archived)}>{selected.record.archived ? "Restore" : "Archive"}</button></div>
        <p role="status" className="text-13 text-muted" aria-live="polite">{status === "saving" ? "Saving…" : status === "saved" ? "Saved" :
          status === "unsaved" ? "Unsaved changes; leave this field to save" : status === "failed" ? "Not saved" : ""}</p>
        {error && <div role="alert" className="flex flex-wrap items-center gap-2 text-13 text-danger"><span>{error}</span>
          {retryRef.current && <button type="button" className={buttonClass("secondary")} disabled={busy}
            onClick={() => void retryRef.current?.()}>Retry save</button>}</div>}
        {lastChange && <button type="button" className="min-h-11 text-13 underline" disabled={busy || dirty}
          onClick={() => void undo(lastChange)}>Undo last change</button>}
        <fieldset className="grid gap-3 border border-line-muted p-4 sm:grid-cols-2"><legend className="px-1 text-14 font-semibold">Details</legend>
          <label className="grid gap-1 sm:col-span-2"><span className={labelClass}>Title</span><input className={inputClass} maxLength={250}
            value={fields.title} onChange={event => changeFields({ ...fields, title: event.target.value })} onBlur={() => void saveRecord()} /></label>
          {(selected.record.kind === "engagement" || selected.record.kind === "role") && <label className="grid gap-1"><span className={labelClass}>Arrangement</span><select className={selectClass}
            value={fields.arrangement ?? ""} onChange={event => { changeFields({ ...fields, arrangement: event.target.value as CareerRecordFields["arrangement"] || null }); }}
            onBlur={() => void saveRecord()}><option value="">Not specified</option>{arrangements.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
          {selected.record.kind !== "skill" && <><label className="grid gap-1"><span className={labelClass}>From (year or year-month)</span><input className={inputClass} placeholder="2021 or 2021-06"
            value={fields.dates.start ?? ""} onChange={event => changeFields({ ...fields, dates: { ...fields.dates, start: event.target.value || null } })}
            onBlur={() => void saveRecord()} /></label>
          <label className="grid gap-1"><span className={labelClass}>To (year or year-month)</span><input className={inputClass} placeholder="2024 or 2024-09"
            disabled={fields.dates.current} value={fields.dates.end ?? ""}
            onChange={event => changeFields({ ...fields, dates: { ...fields.dates, end: event.target.value || null } })}
            onBlur={() => void saveRecord()} /></label>
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={fields.dates.current}
            onChange={event => { const next = { ...fields, dates: { ...fields.dates, current: event.target.checked,
              end: event.target.checked ? null : fields.dates.end } }; changeFields(next); window.queueMicrotask(() => void saveRecord()); }} /> Current</label></>}
          {selected.record.kind !== "skill" && <label className="grid gap-1 sm:col-span-2"><span className={labelClass}>Your original story</span><textarea className={inputClass}
            rows={4} maxLength={40000} value={fields.originalNarrative}
            onChange={event => changeFields({ ...fields, originalNarrative: event.target.value })} onBlur={() => void saveRecord()} /></label>}
          {selected.record.kind !== "skill" && <label className="grid gap-1 sm:col-span-2"><span className={labelClass}>Industries (optional)</span><input className={inputClass}
            value={industriesText} maxLength={2400} placeholder="e.g. Healthcare, Software"
            onChange={event => { setIndustriesText(event.target.value); setStatus("unsaved"); }}
            onBlur={() => { const next = { ...fieldsRef.current,
              industries: industriesText.split(",").map(value => value.trim()).filter(Boolean) };
              changeFields(next); window.queueMicrotask(() => void saveRecord()); }} /></label>}
          <label className="flex min-h-11 items-center gap-2 sm:col-span-2"><input type="checkbox" checked={fields.confidential}
            onChange={event => { changeFields({ ...fields, confidential: event.target.checked }); window.queueMicrotask(() => void saveRecord()); }} /> Keep private identity out of public CVs</label>
          {selected.effectiveConfidential && <label className="grid gap-1 sm:col-span-2"><span className={labelClass}>Public label</span><input className={inputClass}
            maxLength={250} value={fields.publicLabel ?? ""} placeholder="e.g. Confidential healthcare client"
            onChange={event => changeFields({ ...fields, publicLabel: event.target.value || null })} onBlur={() => void saveRecord()} /></label>}
        </fieldset>
        {selected.record.kind === "skill" && <details className="border-b border-line-muted pb-2"><summary className="min-h-11 cursor-pointer text-13 underline">Supporting notes (optional)</summary>
          <label className="mt-2 grid gap-1"><span className={labelClass}>Supporting notes</span><textarea className={inputClass}
            rows={3} maxLength={40000} value={fields.originalNarrative}
            onChange={event => changeFields({ ...fields, originalNarrative: event.target.value })} onBlur={() => void saveRecord()} /></label></details>}
        <section className="space-y-2"><h4 className="text-14 font-semibold">{selected.record.kind === "skill" ? "Skill labels" : "Contributions and facts"}</h4>
          {selected.record.kind === "skill" && !selected.effectiveConfidential && <SkillTagPicker label="Skills in this area"
            selected={selected.assertions.filter(row => row.status === "usable").map(row => row.text)}
            choices={workspace.skillChoices}
            limit={20} maxLabelLength={120} disabled={busy || recordDirty || assertionDirty}
            onAdd={label => { if (!selected.assertions.some(row => row.status === "usable" && skillKey(row.text) === skillKey(label)))
              void addAssertion(label); }}
            onRemove={index => { const row = selected.assertions.filter(item => item.status === "usable")[index];
              if (row) void retractAssertion(row.id, row.revision, true); }} />}
          {(selected.record.kind !== "skill" || selected.effectiveConfidential) && <>
          <ul className="divide-y divide-line-faint border-y border-line-faint">{selected.assertions.filter(row => row.status === "usable").map(row =>
            <li key={row.id} id={`career-assertion-${row.id}`} className="space-y-1 py-2 scroll-mt-20">
              <label className="grid gap-1"><span className={labelClass}>Saved detail</span><textarea className={inputClass} rows={2}
                value={assertionEdits[row.id] ?? row.text} onChange={event => { const next = { ...assertionEditsRef.current, [row.id]: event.target.value };
                  assertionEditsRef.current = next; setAssertionEdits(next); }}
                onBlur={() => void editAssertion(row.id, row.revision, row.text)} /></label>
              {(selected.effectiveConfidential || !!row.publicText || !!publicAssertionEdits[row.id]) && <label className="grid gap-1"><span className={labelClass}>CV wording (optional)</span><input className={inputClass}
                maxLength={4000} value={publicAssertionEdits[row.id] ?? row.publicText ?? ""}
                onChange={event => { const next = { ...publicAssertionEditsRef.current, [row.id]: event.target.value };
                  publicAssertionEditsRef.current = next; setPublicAssertionEdits(next); }}
                onBlur={() => void editAssertion(row.id, row.revision, row.text)} /></label>}
              <p className="text-12 text-muted">{row.provenance.kind === "direct_user" ? "Added by you" :
                row.provenance.kind === "document" ? "From an imported document" : row.provenance.kind === "legacy_saved" ? "From earlier saved Experience" : "Suggested organisation"}</p>
              <button type="button" className="min-h-11 text-13 underline" disabled={busy || recordDirty || assertionDirty}
                onClick={() => void retractAssertion(row.id, row.revision, true)}>Remove detail</button>
            </li>)}</ul>
          {selected.assertionsNextCursor && <a className="inline-flex min-h-11 items-center text-13 underline"
            href={`/library?record=${selected.record.id}&assertionsCursor=${encodeURIComponent(selected.assertionsNextCursor)}#career-record-${selected.record.id}`}
            onClick={event => { if (dirty || busy) { event.preventDefault(); setError("Save or retry this detail before opening older facts."); } }}>
            Older facts</a>}
          <label className="grid gap-1"><span className={labelClass}>Add a detail</span><textarea className={inputClass} rows={2}
            value={assertion} onChange={event => setAssertion(event.target.value)} placeholder="What did you do or achieve?" /></label>
          {(selected.effectiveConfidential || !!publicAssertion) && <label className="grid gap-1"><span className={labelClass}>CV wording (optional)</span><input className={inputClass}
            maxLength={4000} value={publicAssertion} onChange={event => setPublicAssertion(event.target.value)}
            placeholder="A public-safe version, if you want this detail used in a CV" /></label>}
          <button type="button" className={buttonClass("secondary")} disabled={busy || recordDirty || assertionDirty || !assertion.trim()} onClick={() => void addAssertion()}>Save detail · free</button>
          </>}
        </section>
        <section className="space-y-2"><h4 className="text-14 font-semibold">Relationships</h4>
          <ul className="space-y-1 text-13">{selected.links.filter(row => !row.archived).map(row =>
            <li key={row.id} className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1">
              {row.fromId === selected.record.id
                ? `${relationships.find(([kind]) => kind === row.kind)?.[1]} · ${row.otherTitle}`
                : `${row.otherTitle} · ${relationships.find(([kind]) => kind === row.kind)?.[1]} this record`}
              {row.confidential && " · Private"}</span><button type="button" className="min-h-11 underline" disabled={busy || recordDirty || assertionDirty}
                onClick={() => void removeLink(row.id, row.revision)}>Remove link</button></li>)}</ul>
          {selected.linksNextCursor && <a className="inline-flex min-h-11 items-center text-13 underline"
            href={`/library?record=${selected.record.id}&linksCursor=${encodeURIComponent(selected.linksNextCursor)}#career-record-${selected.record.id}`}
            onClick={event => { if (dirty || busy) { event.preventDefault(); setError("Save or retry this detail before opening older links."); } }}>
            Older links</a>}
          <div className="flex flex-wrap gap-2"><label className="grid gap-1"><span className={labelClass}>Relationship</span><select className={selectClass} value={linkKind}
            onChange={event => setLinkKind(event.target.value as typeof linkKind)}>{relationships.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="grid min-w-0 flex-1 gap-1"><span className={labelClass}>With</span><select className={selectClass} value={linkTo}
              onChange={event => setLinkTo(event.target.value)}><option value="">Choose a record</option>{shown.filter(row => row.id !== selected.record.id && !row.archived).map(row =>
                <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
            <button type="button" className={buttonClass("secondary")} disabled={busy || recordDirty || assertionDirty || !linkTo} onClick={() => void addLink()}>Link records</button></div>
          <label className="flex min-h-11 items-center gap-2 text-13"><input type="checkbox" checked={linkConfidential}
            onChange={event => setLinkConfidential(event.target.checked)} />Keep this relationship private in public CVs</label>
          {linkConfidential && <label className="grid gap-1"><span className={labelClass}>Public relationship label (optional)</span>
            <input className={inputClass} maxLength={250} value={linkPublicLabel} onChange={event => setLinkPublicLabel(event.target.value)}
              placeholder="e.g. Confidential healthcare client" /></label>}
        </section>
        <details className="border-t border-line-muted pt-2"><summary className="min-h-11 cursor-pointer text-13 underline">Perspectives on this work</summary>
          <p className="text-12 text-muted">A perspective highlights existing facts. It does not create another job or independent evidence.</p>
          <ul className="divide-y divide-line-faint">{selected.perspectives.filter(row => !row.archived).map(row =>
            <li key={row.id} className="flex flex-wrap items-center gap-2 py-2 text-13"><span className="min-w-0 flex-1">{row.label}{row.note ? ` · ${row.note}` : ""}</span>
              <button type="button" className="min-h-11 underline" disabled={busy || recordDirty || assertionDirty}
                onClick={() => { setPerspectiveId(row.id); setPerspectiveLabel(row.label); setPerspectiveNote(row.note);
                  setPerspectiveAssertions(row.assertionIds); }}>Edit</button>
              <button type="button" className="min-h-11 underline" disabled={busy || recordDirty || assertionDirty}
                onClick={() => void removePerspective(row.id, row.revision)}>Remove</button></li>)}</ul>
          <div className="grid gap-2"><label className="grid gap-1"><span className={labelClass}>Perspective name</span><input className={inputClass}
            maxLength={200} value={perspectiveLabel} onChange={event => setPerspectiveLabel(event.target.value)} placeholder="e.g. Operational delivery" /></label>
            <label className="grid gap-1"><span className={labelClass}>What this highlights (optional)</span><textarea className={inputClass}
              rows={2} maxLength={2000} value={perspectiveNote} onChange={event => setPerspectiveNote(event.target.value)} /></label>
            <fieldset><legend className="text-13 font-medium">Facts behind this view</legend>
              {selected.assertions.filter(row => row.status === "usable").map(row => <label key={row.id} className="flex min-h-11 items-center gap-2 text-13">
                <input type="checkbox" checked={perspectiveAssertions.includes(row.id)} onChange={event => setPerspectiveAssertions(current =>
                  event.target.checked ? [...current, row.id] : current.filter(id => id !== row.id))} />{row.text}</label>)}</fieldset>
            <button type="button" className={buttonClass("secondary")} disabled={busy || !perspectiveLabel.trim()}
              onClick={() => void savePerspective()}>{perspectiveId ? "Update perspective" : "Save perspective"}</button></div>
        </details>
        {selected.assertions.some(row => row.status === "proposed") &&
          <details className="border-t border-line-muted pt-2"><summary className="min-h-11 cursor-pointer text-13 underline">Optional writing and fact suggestions</summary>
            <p className="text-12 text-muted">Suggestions do not change your saved facts or block a CV.</p>
            {selected.assertions.filter(row => row.status === "proposed").map(row => <p key={row.id}
              id={`career-assertion-${row.id}`} className="mt-2 scroll-mt-20 text-13">Suggested: {row.text}</p>)}
          </details>}
        <details><summary className="min-h-11 cursor-pointer text-13 underline">History and recovery</summary>
          {selected.assertions.filter(row => row.status === "retracted").map(row => <p key={row.id}
            id={`career-assertion-${row.id}`} className="flex scroll-mt-20 flex-wrap items-center gap-2 text-13">
            <span className="min-w-0 flex-1">Removed detail: {row.text}</span><button type="button" className="min-h-11 underline" disabled={busy || recordDirty || assertionDirty}
              onClick={() => void retractAssertion(row.id, row.revision, false)}>Restore detail</button></p>)}
          <ul className="divide-y divide-line-faint text-13">{selected.changes.map(change => <li key={change.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>{new Date(change.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</span>
            <button type="button" className="min-h-11 underline" disabled={busy || dirty} onClick={() => void undo(change.id)}>Undo change</button>
          </li>)}</ul>
          {selected.changesNextCursor !== null && <a className="inline-flex min-h-11 items-center text-13 underline"
            href={`/library?record=${selected.record.id}&changesCursor=${selected.changesNextCursor}#career-record-${selected.record.id}`}
            onClick={event => { if (dirty || busy) { event.preventDefault(); setError("Save or retry this detail before opening older changes."); } }}>
            Older changes</a>}
        </details>
      </div> : <p className="text-14 text-muted">Choose a saved record, or add a new one above.</p>}
    </div>
  </section>;
}
