"use client";

import { useEffect, useState } from "react";
import { readCvHistoryPage } from "@/app/actions/cv-history";
import { CvSelectEdition } from "./CvSelectEdition";

type Baseline = { id: string; status: string; descriptionVersionId: string | null;
  createdAt: Date; publishedAt: Date | null };
type Edition = { id: string; status: string; editingMode: string | null; revision: number;
  finalisedAt: Date | null; createdAt: Date };
type Cursor = { baselines: string; editions: string } | null;

function prependNew<T extends { id: string }>(incoming: T[], previous: T[]) {
  const seen = new Set(incoming.map(row => row.id));
  return [...incoming, ...previous.filter(row => !seen.has(row.id))];
}

/** History is a task view in the mounted editor, so paging and selection retain unsaved mode buffers. */
export function CvHistory({ contextId, selected, initialBaselines, initialEditions, initialOlder }: {
  contextId: string; selected: { kind: "baseline" | "draft"; id: string } | null;
  initialBaselines: Baseline[]; initialEditions: Edition[]; initialOlder: Cursor;
}) {
  const [baselines, setBaselines] = useState(initialBaselines);
  const [editions, setEditions] = useState(initialEditions);
  const [older, setOlder] = useState(initialOlder);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBaselines(previous => prependNew(initialBaselines, previous));
    setEditions(previous => prependNew(initialEditions, previous));
  }, [initialBaselines, initialEditions]);
  async function loadOlder() {
    if (!older || pending) return;
    setPending(true); setError(null);
    try {
      const result = await readCvHistoryPage(contextId, older);
      if (!result.ok) { setError(result.error); return; }
      setBaselines(previous => prependNew(previous, result.baselines));
      setEditions(previous => prependNew(previous, result.editions));
      setOlder(result.older);
    } catch { setError("Could not load older CVs. Try again."); }
    finally { setPending(false); }
  }
  const date = (value: Date | string) => new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  return <div className="space-y-4 border border-line-muted p-4 text-14">
    <h2 className="font-semibold">Saved CV history</h2>
    {baselines.length > 0 && <section><h3 className="font-medium">Auto results</h3><ul className="space-y-2">
      {baselines.map(row => <li key={row.id} className="flex flex-wrap items-center gap-2">
        <CvSelectEdition contextId={contextId} kind="baseline" id={row.id} label="Select this Auto result" />
        {row.status === "ready" && <a className="underline" href={`/api/cv/baseline/${row.id}/pdf`}
          target="_blank" rel="noopener noreferrer">Open saved Auto PDF</a>}
        <span>{selected?.kind === "baseline" && selected.id === row.id ? "Current · " : ""}{row.status} · {date(row.publishedAt ?? row.createdAt)}</span>
      </li>)}</ul></section>}
    {editions.length > 0 && <section><h3 className="font-medium">Saved editions</h3><ul className="space-y-2">
      {editions.map(row => <li key={row.id} className="flex flex-wrap items-center gap-2">
        <CvSelectEdition contextId={contextId} kind="draft" id={row.id}
          label={`Select ${row.editingMode ?? "saved"} edition V${row.revision}`} />
        <span>{selected?.kind === "draft" && selected.id === row.id ? "Current · " : ""}{row.status}
          {row.finalisedAt ? " · final PDF saved" : ""} · {date(row.createdAt)}</span>
      </li>)}</ul></section>}
    {older && <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending}
      onClick={loadOlder}>{pending ? "Loading…" : "Load older CVs"}</button>}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
}
