"use client";

import { useEffect, useRef, useState } from "react";
import { saveDecisionTagsSetting } from "@/app/actions/decisions";
import type { ActionResult } from "@/lib/validation";
import { SettingsForm } from "@/components/SettingsForm";

type TagOption = { tag: string };

export function ReasonTagEditor({ decisionId, tags, tagsEdited, options, disabled, onRetentionChange }: {
  decisionId: string;
  tags: string[];
  tagsEdited: boolean;
  options: TagOption[];
  disabled: boolean;
  /** Keep this editor mounted if it leaves the recent list while edited or saving. */
  onRetentionChange?: (retain: boolean, pending: boolean, saved?: boolean) => void;
}) {
  const incoming = JSON.stringify({ tags, tagsEdited });
  const seenIncoming = useRef(incoming);
  const dirty = useRef(false);
  const saving = useRef(false);
  const editVersion = useRef(0);
  const [editor, setEditor] = useState({ selected: tags, guard: incoming });

  useEffect(() => {
    if (seenIncoming.current === incoming) return;
    seenIncoming.current = incoming;
    // The choices and their guard change together only while this editor is pristine.
    if (!dirty.current) setEditor({ selected: tags, guard: incoming });
  }, [incoming, tags]);

  async function save(previous: ActionResult, data: FormData): Promise<ActionResult> {
    const submittedEdit = editVersion.current;
    dirty.current = true;
    saving.current = true;
    onRetentionChange?.(true, true);
    try {
      const result = await saveDecisionTagsSetting(decisionId, previous, data);
      if (result.ok) {
        const saved = data.getAll("tags").map(String);
        const guard = result.nextSnapshot?.expectedTags ?? JSON.stringify({ tags: saved, tagsEdited: true });
        const stillCurrent = editVersion.current === submittedEdit;
        setEditor(current => ({ selected: stillCurrent ? saved : current.selected, guard }));
        if (stillCurrent) dirty.current = false;
        saving.current = false;
        onRetentionChange?.(!stillCurrent, false, stillCurrent);
      } else {
        saving.current = false;
        onRetentionChange?.(true, false);
      }
      return result;
    } catch (error) {
      saving.current = false;
      onRetentionChange?.(true, false);
      throw error;
    }
  }

  function toggle(tag: string, checked: boolean) {
    dirty.current = true;
    editVersion.current += 1;
    onRetentionChange?.(true, saving.current);
    setEditor(current => ({
      ...current,
      selected: checked ? [...new Set([...current.selected, tag])] : current.selected.filter(value => value !== tag),
    }));
  }

  // Capture submit before useActionState enters its transition: a server refresh can remove this
  // row while the action is pending, and transition updates may not commit until it settles.
  return <div onSubmitCapture={() => {
    dirty.current = true;
    saving.current = true;
    onRetentionChange?.(true, true);
  }}><SettingsForm action={save} resetOnSuccess={false} submitLabel="Save tags" submitDisabled={disabled} successMessage="Tags saved.">
    <fieldset disabled={disabled} className="flex flex-col gap-2">
      <input type="hidden" name="expectedTags" value={editor.guard} />
      <legend className="text-12">Reason tags</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {options.map(option => <label key={option.tag} className="flex min-h-11 items-center gap-2 text-14">
          <input type="checkbox" name="tags" value={option.tag} checked={editor.selected.includes(option.tag)}
            onChange={event => toggle(option.tag, event.target.checked)} />
          {option.tag}
        </label>)}
      </div>
    </fieldset>
  </SettingsForm></div>;
}
