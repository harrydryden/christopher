/**
 * The notepad's storage format, both directions.
 *
 * A company note is stored as markdown-lite text in `company_subscriptions.notes`, so what was
 * typed years ago in a plain textarea is still a valid note and still reads as itself: paragraphs
 * separated by a blank line, `- item` bullet lines, `**bold**` inline. Nothing else is markup.
 *
 * These two functions are the whole grammar, and they are pure: the editor converts its DOM to
 * blocks and back, and never parses or emits HTML from stored text.
 */

/** A span of a line with one weight. Runs are never empty and never adjacent with the same weight. */
export interface NoteRun {
  text: string;
  bold: boolean;
}

export type NoteBlock =
  /** Consecutive non-blank lines. `lines` are the soft breaks inside one paragraph. */
  | { type: "paragraph"; lines: NoteRun[][] }
  /** Consecutive `- ` lines. */
  | { type: "list"; items: NoteRun[][] };

const BULLET = /^\s*-\s+/;

/**
 * Is there an unescaped `**` after `from`? An opening `**` with nothing to close it is text, not
 * markup — a note that says "worth ** the wait" must read as itself rather than swallow the line.
 */
function hasCloser(line: string, from: number): boolean {
  for (let i = from; i < line.length; i++) {
    if (line[i] === "\\") { i++; continue; }
    if (line[i] === "*" && line[i + 1] === "*") return true;
  }
  return false;
}

/** One line of stored text to its runs. `\x` is a literal `x`; `**…**` is bold. */
export function parseRuns(line: string): NoteRun[] {
  const runs: NoteRun[] = [];
  let bold = false;
  let text = "";
  const flush = () => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && last.bold === bold) last.text += text;
    else runs.push({ text, bold });
    text = "";
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\" && i + 1 < line.length) { text += line[i + 1]; i++; continue; }
    if (ch === "*" && line[i + 1] === "*") {
      if (bold) { flush(); bold = false; i++; continue; }
      if (hasCloser(line, i + 2)) { flush(); bold = true; i++; continue; }
      text += "**"; i++; continue;
    }
    text += ch;
  }
  flush();
  return runs;
}

/**
 * A backslash is always escaped; an asterisk only where it would otherwise pair into a `**`. A
 * note that says "3 * 4" keeps its asterisk; one that says "a ** b" gets it escaped, so neither
 * turns into bold on the way back in.
 */
function escapeText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\") { out += "\\\\"; continue; }
    if (ch === "*" && (text[i + 1] === "*" || text[i - 1] === "*")) { out += "\\*"; continue; }
    out += ch;
  }
  return out;
}

function runsToText(runs: NoteRun[]): string {
  return runs
    .filter(run => run.text !== "")
    .map(run => (run.bold ? `**${escapeText(run.text)}**` : escapeText(run.text)))
    .join("");
}

/** Stored text to blocks. Blank lines separate paragraphs; everything else is one of two shapes. */
export function notesToBlocks(markdown: string): NoteBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: NoteBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if ((lines[i] ?? "").trim() === "") { i++; continue; }
    if (BULLET.test(lines[i] ?? "")) {
      const items: NoteRun[][] = [];
      while (i < lines.length && BULLET.test(lines[i] ?? "")) {
        items.push(parseRuns((lines[i] ?? "").replace(BULLET, "")));
        i++;
      }
      blocks.push({ type: "list", items });
      continue;
    }
    const paragraph: NoteRun[][] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "" && !BULLET.test(lines[i] ?? "")) {
      paragraph.push(parseRuns(lines[i] ?? ""));
      i++;
    }
    blocks.push({ type: "paragraph", lines: paragraph });
  }
  return blocks;
}

/** Blocks back to stored text. A paragraph line that opens with a bullet mark is escaped so it stays one. */
export function blocksToNotes(blocks: NoteBlock[]): string {
  return blocks
    .map(block => block.type === "list"
      ? block.items.map(item => `- ${runsToText(item)}`).join("\n")
      : block.lines.map(line => runsToText(line).replace(/^(\s*)([-*])(\s)/, "$1\\$2$3")).join("\n"))
    .join("\n\n");
}
