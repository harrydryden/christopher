"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { saveCompanyNotes } from "@/app/actions/companies";
import { Button } from "@/components/Button";
import { blocksToNotes, notesToBlocks, type NoteBlock, type NoteRun } from "@/lib/notes-markdown";

/** Elements that end a line wherever they appear: a new one starts after them. */
const BLOCK_TAGS = new Set(["P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "SECTION", "ARTICLE"]);

function isBoldElement(el: HTMLElement): boolean {
  if (el.tagName === "STRONG" || el.tagName === "B") return true;
  const weight = el.style?.fontWeight ?? "";
  return weight === "bold" || weight === "bolder" || Number(weight) >= 600;
}

/** Append text to the line being built, merging it into the previous run of the same weight. */
function pushRun(lines: NoteRun[][], text: string, bold: boolean): void {
  if (!text) return;
  const line = lines[lines.length - 1]!;
  const last = line[line.length - 1];
  if (last && last.bold === bold) last.text += text;
  else line.push({ text, bold });
}

/**
 * The editor's DOM to runs. Everything the browser may have produced reduces to three things:
 * a line break, a weight, or text. Anything else — a pasted span, a stray font tag, a table —
 * contributes its text and nothing more, so no markup can survive a save.
 */
function walkInline(node: Node, bold: boolean, lines: NoteRun[][]): void {
  if (node.nodeType === Node.TEXT_NODE) { pushRun(lines, node.nodeValue ?? "", bold); return; }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as HTMLElement;
  if (el.tagName === "BR") { lines.push([]); return; }
  if (BLOCK_TAGS.has(el.tagName) && lines[lines.length - 1]!.length > 0) lines.push([]);
  const nowBold = bold || isBoldElement(el);
  for (const child of Array.from(el.childNodes)) walkInline(child, nowBold, lines);
}

/** The lines of one block element, with the empty tail a contenteditable leaves behind removed. */
function linesOf(node: Node): NoteRun[][] {
  const lines: NoteRun[][] = [[]];
  if (node.nodeType === Node.ELEMENT_NODE) for (const child of Array.from(node.childNodes)) walkInline(child, false, lines);
  else walkInline(node, false, lines);
  while (lines.length > 1 && lines[lines.length - 1]!.length === 0) lines.pop();
  return lines;
}

const hasText = (lines: NoteRun[][]) => lines.some(line => line.some(run => run.text.trim() !== ""));

/** The whole editor to blocks: lists are lists, every other block is a paragraph, blanks are dropped. */
export function blocksFromDom(root: HTMLElement): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let loose: NoteRun[][] | null = null;
  const flushLoose = () => {
    if (loose && hasText(loose)) blocks.push({ type: "paragraph", lines: loose });
    loose = null;
  };
  for (const node of Array.from(root.childNodes)) {
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : null;
    if (el && (el.tagName === "UL" || el.tagName === "OL")) {
      flushLoose();
      const items = Array.from(el.children)
        .filter(child => child.tagName === "LI")
        .map(li => linesOf(li).flat())
        .filter(item => item.some(run => run.text.trim() !== ""));
      if (items.length) blocks.push({ type: "list", items });
      continue;
    }
    if (el && BLOCK_TAGS.has(el.tagName)) {
      flushLoose();
      const lines = linesOf(el);
      if (hasText(lines)) blocks.push({ type: "paragraph", lines });
      continue;
    }
    // A loose text node or inline element at the top level: part of an implicit paragraph.
    loose = loose ?? [[]];
    walkInline(node, false, loose);
  }
  flushLoose();
  return blocks;
}

/** One `<p>` or `<li>`, built node by node. Stored text never reaches `innerHTML`. */
function lineElement(tag: "p" | "li", lines: NoteRun[][]): HTMLElement {
  const el = document.createElement(tag);
  lines.forEach((runs, index) => {
    if (index) el.appendChild(document.createElement("br"));
    for (const run of runs) {
      if (!run.text) continue;
      const text = document.createTextNode(run.text);
      if (!run.bold) { el.appendChild(text); continue; }
      const strong = document.createElement("strong");
      strong.appendChild(text);
      el.appendChild(strong);
    }
  });
  // A browser needs something to put the caret on in an otherwise empty block.
  if (!el.firstChild) el.appendChild(document.createElement("br"));
  return el;
}

function fillEditor(root: HTMLElement, blocks: NoteBlock[]): void {
  root.replaceChildren();
  for (const block of blocks) {
    if (block.type === "paragraph") { root.appendChild(lineElement("p", block.lines)); continue; }
    const list = document.createElement("ul");
    for (const item of block.items) list.appendChild(lineElement("li", [item]));
    root.appendChild(list);
  }
  if (!root.firstChild) root.appendChild(lineElement("p", [[]]));
}

const clockOf = (at: Date) => at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/**
 * The company notepad: a small rich-text editor over the same markdown-lite text the plain
 * textarea used to write, so nothing anybody typed before is lost or reformatted.
 *
 * `execCommand` is deprecated but not replaced, and here it is the right tool: bold and a bullet
 * list, applied to the selection, with the browser's own undo stack intact. Whatever DOM it leaves
 * behind is read back through `blocksFromDom`, so only the two things this format has can be saved.
 */
export function CompanyNotepad({ companyId, notes }: { companyId: string; notes: string }) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [bold, setBold] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The text the editor was last built from or last saved. */
  const syncedRef = useRef<string | null>(null);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    // A save revalidates the page, so this prop comes back holding what was just written. Rebuilding
    // the editor then would throw away anything typed in the meantime, so our own text is skipped.
    if (syncedRef.current === notes) return;
    syncedRef.current = notes;
    fillEditor(editor, notesToBlocks(notes));
  }, [notes]);

  const syncBold = useCallback(() => {
    const editor = editorRef.current;
    const selection = document.getSelection();
    if (!editor || !selection?.anchorNode || !editor.contains(selection.anchorNode)) return;
    try { setBold(document.queryCommandState("bold")); } catch { /* not every engine answers */ }
  }, []);

  useEffect(() => {
    document.addEventListener("selectionchange", syncBold);
    return () => document.removeEventListener("selectionchange", syncBold);
  }, [syncBold]);

  const save = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || pending) return;
    const text = blocksToNotes(blocksFromDom(editor));
    setPending(true);
    setError(null);
    startTransition(async () => {
      try {
        const result = await saveCompanyNotes(companyId, text);
        if (result.ok) { syncedRef.current = text; setSavedAt(new Date()); setDirty(false); }
        else setError(result.error);
      } catch {
        setError("Could not save your notes. Reload to check the current state before retrying.");
      } finally { setPending(false); }
    });
  }, [companyId, pending]);

  function command(name: "bold" | "insertUnorderedList") {
    editorRef.current?.focus();
    try { document.execCommand(name); } catch { /* nothing to apply it to */ }
    setDirty(true);
    syncBold();
  }

  return (
    <div className="flex flex-col gap-3">
      <div role="toolbar" aria-label="Note formatting" aria-controls={`notepad-${companyId}`} className="flex flex-wrap items-center gap-2">
        {/* The selection is the argument to both commands, so the toolbar must never take focus. */}
        <Button size="sm" aria-pressed={bold} aria-label="Bold" onMouseDown={event => event.preventDefault()} onClick={() => command("bold")}>Bold</Button>
        <Button size="sm" aria-label="Bullet list" onMouseDown={event => event.preventDefault()} onClick={() => command("insertUnorderedList")}>Bullet list</Button>
        <span className="text-12 text-muted" aria-live="polite">
          {dirty ? "Unsaved changes" : savedAt ? `Saved ${clockOf(savedAt)}` : ""}
        </span>
      </div>
      <div
        id={`notepad-${companyId}`}
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        aria-label="Your notes"
        contentEditable
        suppressContentEditableWarning
        spellCheck
        lang="en-GB"
        // The control shape from components/Field.tsx, at eight lines of the body size.
        className="ds-notepad min-h-48 w-full overflow-y-auto border-2 border-line-muted bg-bg px-3 py-2 text-14 leading-relaxed text-fg focus:border-line focus:outline-none"
        onInput={() => { setDirty(true); setError(null); }}
        onKeyUp={syncBold}
        onMouseUp={syncBold}
        onKeyDown={event => {
          if (!(event.metaKey || event.ctrlKey)) return;
          const key = event.key.toLowerCase();
          if (key === "b") { event.preventDefault(); command("bold"); }
          else if (key === "s") { event.preventDefault(); save(); }
        }}
      />
      {error && <p className="text-14 text-danger">{error}</p>}
      <div>
        <Button variant="primary" size="sm" disabled={pending} onClick={save}>{pending ? "Saving…" : "Save"}</Button>
      </div>
    </div>
  );
}
