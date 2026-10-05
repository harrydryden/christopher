/** Recent decisions live only in this browser tab and are isolated by account. */
export interface RoleUndoEntry { jobId: string; text: string; revision: string; decisionId?: string }

const LIMIT = 5;
export const ROLE_UNDO_CHANGED = "col:role-undo-changed";
const key = (scope: string) => `col:role-undo:${scope}`;
const revisionKey = (scope: string, jobId: string) => `col:role-undo-revision:${scope}:${jobId}`;

export function recentRoleUndos(scope: string): RoleUndoEntry[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(key(scope)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is RoleUndoEntry => !!entry && typeof entry.jobId === "string"
      && typeof entry.text === "string" && typeof entry.revision === "string" && typeof entry.decisionId === "string").slice(0, LIMIT);
  } catch { return []; }
}

/** An older build stored only role ids; those cannot safely undo a newer decision. */
export function hasLegacyRoleUndos(scope: string): boolean {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(key(scope)) ?? "[]");
    return Array.isArray(parsed) && parsed.some(entry => entry && typeof entry.jobId === "string" && typeof entry.decisionId !== "string");
  } catch { return false; }
}

export function discardLegacyRoleUndos(scope: string): void { write(scope, recentRoleUndos(scope)); }

/** A newer decision invalidates an older Undo, even when the earlier request finishes later. */
export function claimRoleRevision(scope: string, jobId: string): string {
  const revision = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  try { sessionStorage.setItem(revisionKey(scope, jobId), revision); } catch { /* In-memory notice still works. */ }
  forgetRoleUndo(scope, jobId);
  return revision;
}

export function isCurrentRoleRevision(scope: string, entry: Pick<RoleUndoEntry, "jobId" | "revision">): boolean {
  try { return sessionStorage.getItem(revisionKey(scope, entry.jobId)) === entry.revision; }
  catch { return true; }
}

export function rememberRoleUndo(scope: string, entry: RoleUndoEntry): void {
  if (!entry.decisionId || !isCurrentRoleRevision(scope, entry)) return;
  write(scope, [entry, ...recentRoleUndos(scope).filter(item => item.jobId !== entry.jobId)].slice(0, LIMIT));
}

export function forgetRoleUndo(scope: string, jobId: string): void {
  write(scope, recentRoleUndos(scope).filter(item => item.jobId !== jobId));
}

function write(scope: string, entries: RoleUndoEntry[]): void {
  try { sessionStorage.setItem(key(scope), JSON.stringify(entries)); } catch { /* The current page still has its own state. */ }
  window.dispatchEvent(new Event(ROLE_UNDO_CHANGED));
}
