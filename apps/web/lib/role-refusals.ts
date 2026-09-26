/**
 * Refusals that arrive after the roles table that asked has gone.
 *
 * A decision takes its row off the page before the server answers, so the person can page, filter
 * or switch tab while it is being saved; the table is keyed on the query and page, so it remounts,
 * and a refusal that lands then has no table to put the row back into or show its sentence in.
 * It is kept here instead, in the browser tab's memory, and `RoleRefusalNotices` (rendered by the
 * workspace beside the table, not inside it) shows it until it is dismissed. The row itself needs
 * nothing: the server kept it as it was, and the new table's page lists it.
 */
export interface RoleRefusal {
  id: number;
  text: string;
}

let refusals: readonly RoleRefusal[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

/** At most this many are kept; older ones have been on screen long enough. */
const KEPT = 5;

function emit() {
  for (const listener of listeners) listener();
}

/** "Could not save <what>: <why>", for a table that has unmounted since it sent the write. */
export function reportRoleRefusal(what: string, reason: string): void {
  refusals = [...refusals, { id: nextId++, text: `Could not save ${what}: ${reason}` }].slice(-KEPT);
  emit();
}

export function dismissRoleRefusal(id: number): void {
  refusals = refusals.filter(refusal => refusal.id !== id);
  emit();
}

export function subscribeRoleRefusals(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function roleRefusals(): readonly RoleRefusal[] {
  return refusals;
}

const NONE: readonly RoleRefusal[] = [];
/** The server has none: a refusal only ever arrives in the browser. */
export function serverRoleRefusals(): readonly RoleRefusal[] {
  return NONE;
}
