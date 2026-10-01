"use client";

import { useEffect, useRef, useState } from "react";
import { SettingsForm } from "@/components/SettingsForm";
import type { ActionResult } from "@/lib/validation";

export function LearningProfileEditor({ action, name, id, label, text, version, rows, disabled, submitLabel, description, required = false, maxLength }: {
  action: (previous: ActionResult, data: FormData) => Promise<ActionResult>;
  name: "markdown" | "pinnedStatements";
  id: string;
  label: string;
  text: string;
  version: number;
  rows: number;
  disabled: boolean;
  submitLabel: string;
  description?: string;
  required?: boolean;
  maxLength?: number;
}) {
  const incoming = JSON.stringify({ text, version });
  const seenIncoming = useRef(incoming);
  const dirty = useRef(false);
  const editVersion = useRef(0);
  const [editor, setEditor] = useState({ text, version });

  useEffect(() => {
    if (seenIncoming.current === incoming) return;
    seenIncoming.current = incoming;
    if (!dirty.current) setEditor({ text, version });
  }, [incoming, text, version]);

  async function save(previous: ActionResult, data: FormData): Promise<ActionResult> {
    const submittedEdit = editVersion.current;
    const result = await action(previous, data);
    if (result.ok) {
      const nextVersion = Number(result.nextSnapshot?.profileVersion ?? editor.version + 1);
      const stillCurrent = editVersion.current === submittedEdit;
      setEditor(current => ({ text: stillCurrent ? String(data.get(name) ?? "") : current.text, version: nextVersion }));
      if (stillCurrent) dirty.current = false;
    }
    return result;
  }

  return <SettingsForm action={save} resetOnSuccess={false} submitLabel={submitLabel} submitDisabled={disabled}>
    <fieldset disabled={disabled} className="flex flex-col gap-2">
      <input type="hidden" name="profileVersion" value={editor.version} />
      <label htmlFor={id} className="text-14">{label}</label>
      <textarea id={id} name={name} required={required} maxLength={maxLength} rows={rows} value={editor.text}
        onChange={event => {
          dirty.current = true;
          editVersion.current += 1;
          setEditor(current => ({ ...current, text: event.target.value }));
        }}
        className="w-full border border-line-muted px-2 py-1.5 text-14 outline-none focus:border-line" />
      {description && <p className="text-12 text-muted">{description}</p>}
    </fieldset>
  </SettingsForm>;
}
