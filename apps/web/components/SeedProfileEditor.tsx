"use client";

import { useEffect, useRef, useState } from "react";
import { SettingsForm } from "@/components/SettingsForm";
import type { ActionResult } from "@/lib/validation";

export function SeedProfileEditor({ text, action, label = "Starting preferences", rows = 4, placeholder }: {
  text: string;
  action: (previous: ActionResult, data: FormData) => Promise<ActionResult>;
  label?: string;
  rows?: number;
  placeholder?: string;
}) {
  const seenIncoming = useRef(text);
  const dirty = useRef(false);
  const editVersion = useRef(0);
  const [editor, setEditor] = useState({ text, expected: text });

  useEffect(() => {
    if (seenIncoming.current === text) return;
    seenIncoming.current = text;
    if (!dirty.current) setEditor({ text, expected: text });
  }, [text]);

  async function save(previous: ActionResult, data: FormData): Promise<ActionResult> {
    const submittedEdit = editVersion.current;
    const result = await action(previous, data);
    if (result.ok) {
      const saved = result.nextSnapshot?.expectedSeedProfile ?? String(data.get("seedProfile") ?? "");
      const stillCurrent = editVersion.current === submittedEdit;
      setEditor(current => ({ text: stillCurrent ? saved : current.text, expected: saved }));
      if (stillCurrent) dirty.current = false;
    }
    return result;
  }

  return <SettingsForm action={save} resetOnSuccess={false} successMessage="Saved.">
    <label className="flex flex-col gap-1.5 text-14">
      <span className="text-14">{label}</span>
      <input type="hidden" name="expectedSeedProfile" value={editor.expected} />
      <textarea name="seedProfile" rows={rows} maxLength={5000} value={editor.text} placeholder={placeholder}
        onChange={event => {
          dirty.current = true;
          editVersion.current += 1;
          setEditor(current => ({ ...current, text: event.target.value }));
        }}
        className="w-full resize-y border border-line-muted px-2 py-1.5 text-14 outline-none focus:border-line" />
    </label>
  </SettingsForm>;
}
