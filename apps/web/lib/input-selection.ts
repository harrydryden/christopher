/** Read at invocation time so inline AI edits use the current selection in either CV mode. */
export function inputSelection(id: string): { start: number; end: number } | null {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLTextAreaElement) && !(input instanceof HTMLInputElement)) return null;
  return { start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 };
}
