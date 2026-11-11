"use client";

import { useId, useState } from "react";

export const skillKey = (value: string) => value.trim().toLocaleLowerCase("en-GB");

/** Labels are atomic: a comma can be part of one skill, never a separator here. */
export function SkillTagPicker({ label, selected, choices, limit, onAdd, onRemove, showSelected = true, maxLabelLength = 150, disabled = false }: {
  label: string; selected: readonly string[]; choices: readonly string[]; limit: number;
  onAdd: (label: string) => void; onRemove: (index: number) => void; showSelected?: boolean; maxLabelLength?: number; disabled?: boolean;
}) {
  const id = useId();
  const [newLabel, setNewLabel] = useState("");
  const selectedKeys = new Set(selected.map(skillKey));
  const available = choices.filter((choice, index, all) => choice.trim() && !selectedKeys.has(skillKey(choice)) &&
    all.findIndex(other => skillKey(other) === skillKey(choice)) === index);
  const canAdd = selected.length < limit;
  const candidate = newLabel.trim();
  return <div className="space-y-2" role="group" aria-labelledby={id}>
    <p id={id} className="text-13 font-medium">{label}</p>
    {showSelected && selected.length > 0 && <ul className="flex flex-wrap gap-2" aria-label={`${label} selected`}>
      {selected.map((item, index) => <li key={`${index}-${item}`} className="inline-flex items-center rounded-full border border-line-muted text-13">
        <span className="px-3 py-2">{item}</span><button type="button" className="min-h-11 rounded-r-full border-l border-line-muted px-3"
          aria-label={`Remove ${item}`} disabled={disabled} onClick={() => onRemove(index)}>×</button></li>)}
    </ul>}
    {available.length > 0 && <div className="flex flex-wrap gap-2" aria-label={`${label} suggestions`}>
      {available.map(choice => <button key={skillKey(choice)} type="button" className="min-h-11 rounded-full border border-line-muted px-3 text-13"
        disabled={disabled || !canAdd} aria-label={`Add ${choice}`} onClick={() => onAdd(choice)}>{choice} +</button>)}
    </div>}
    <div className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 text-13" htmlFor={`${id}-new`}>New skill label
      <input id={`${id}-new`} className="mt-1 min-h-11 w-full border border-line-muted bg-raised px-3" maxLength={maxLabelLength} disabled={disabled}
        value={newLabel} onChange={event => setNewLabel(event.target.value)} /></label>
      <button type="button" className="min-h-11 border border-line-muted px-4 text-13" disabled={disabled || !canAdd || !candidate || candidate.length > maxLabelLength || selectedKeys.has(skillKey(candidate))}
        onClick={() => { onAdd(candidate); setNewLabel(""); }}>Add skill</button></div>
    <p className="text-12 text-muted" aria-live="polite">{selected.length}/{limit} skills selected</p>
  </div>;
}
