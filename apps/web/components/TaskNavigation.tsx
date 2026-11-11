"use client";

import { useRef, type KeyboardEvent } from "react";

export type TaskNavigationItem<Id extends string> = {
  id: Id;
  label: string;
  panelId: string;
  disabled?: boolean;
};

/** Switches already-mounted task panels; parents keep their form buffers. */
export function TaskNavigation<Id extends string>({ label, idPrefix, items, active, onSelect }: {
  label: string;
  idPrefix: string;
  items: readonly TaskNavigationItem<Id>[];
  /** The caller keeps this ID in items and enabled. */
  active: Id;
  onSelect: (id: Id) => void;
}) {
  const tabs = useRef(new Map<Id, HTMLButtonElement>());
  const selectFromKey = (event: KeyboardEvent<HTMLButtonElement>, current: Id) => {
    const available = items.filter(item => !item.disabled);
    const index = available.findIndex(item => item.id === current);
    if (index < 0 || available.length === 0) return;
    let next: TaskNavigationItem<Id> | undefined;
    if (event.key === "ArrowRight") next = available[(index + 1) % available.length];
    else if (event.key === "ArrowLeft") next = available[(index - 1 + available.length) % available.length];
    else if (event.key === "Home") next = available[0];
    else if (event.key === "End") next = available[available.length - 1];
    if (!next) return;
    event.preventDefault();
    onSelect(next.id);
    tabs.current.get(next.id)?.focus();
  };
  return <div role="tablist" aria-label={label} className="flex min-w-0 flex-wrap gap-2">
    {items.map(item => <button key={item.id} type="button" role="tab"
      id={`${idPrefix}-tab-${item.id}`} aria-controls={item.panelId}
      aria-selected={active === item.id} tabIndex={active === item.id ? 0 : -1}
      disabled={item.disabled}
      ref={node => { if (node) tabs.current.set(item.id, node); else tabs.current.delete(item.id); }}
      onClick={() => onSelect(item.id)} onKeyDown={event => selectFromKey(event, item.id)}
      className={`min-h-11 min-w-0 max-w-full break-words border-2 px-3 py-2 text-left text-14 font-semibold ${active === item.id
        ? "border-accent bg-accent text-accent-fg" : "border-line bg-raised text-fg"}`}>
      {item.label}
    </button>)}
  </div>;
}
