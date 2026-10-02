/** A bounded, line-level comparison for stored profile text. */
export type DiffLine = { kind: "unchanged" | "added" | "removed"; text: string };
export type DisplayLine = { kind: DiffLine["kind"]; lines: string[] } | { kind: "omitted"; count: number };

const LOOKAHEAD = 24;
const MAX_DISPLAY_ROWS = 800;

export function textLines(text: string): string[] {
  return text === "" ? [] : text.replace(/\r\n?/g, "\n").split("\n");
}

/**
 * Compare nearby lines without an LCS matrix. Each mismatch checks at most 24 future lines;
 * even two 50,000-line inputs take linear space and bounded work per line. A distant move is
 * shown as a removal and addition, which is clearer than hiding it behind a costly guess.
 */
export function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  const result: DiffLine[] = [];
  let old = 0;
  let next = 0;
  while (old < before.length && next < after.length) {
    if (before[old] === after[next]) {
      result.push({ kind: "unchanged", text: before[old]! });
      old++;
      next++;
      continue;
    }
    let removed = 0;
    let added = 0;
    for (let distance = 1; distance <= LOOKAHEAD; distance++) {
      if (!removed && old + distance < before.length && before[old + distance] === after[next]) removed = distance;
      if (!added && next + distance < after.length && after[next + distance] === before[old]) added = distance;
      if (removed || added) break;
    }
    if (removed && (!added || removed <= added)) {
      for (let i = 0; i < removed; i++) result.push({ kind: "removed", text: before[old++]! });
    } else if (added) {
      for (let i = 0; i < added; i++) result.push({ kind: "added", text: after[next++]! });
    } else {
      result.push({ kind: "removed", text: before[old++]! }, { kind: "added", text: after[next++]! });
    }
  }
  while (old < before.length) result.push({ kind: "removed", text: before[old++]! });
  while (next < after.length) result.push({ kind: "added", text: after[next++]! });
  return result;
}

/** Show changes with one neighbouring line, omitting long unchanged stretches and capping DOM. */
export function displayDiff(lines: readonly DiffLine[]): { rows: DisplayLine[]; added: number; removed: number; truncated: boolean } {
  let added = 0;
  let removed = 0;
  const keep = new Uint8Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.kind === "unchanged") continue;
    if (lines[i]!.kind === "added") added++;
    else removed++;
    if (i > 0) keep[i - 1] = 1;
    keep[i] = 1;
    if (i + 1 < lines.length) keep[i + 1] = 1;
  }
  if (!added && !removed) return { rows: [], added, removed, truncated: false };
  const visible: Array<DiffLine | { kind: "omitted"; count: number }> = [];
  let omitted = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) { omitted++; continue; }
    if (omitted) { visible.push({ kind: "omitted", count: omitted }); omitted = 0; }
    visible.push(lines[i]!);
  }
  if (omitted) visible.push({ kind: "omitted", count: omitted });
  // Thousands of added lines need one labelled text block, not thousands of DOM elements.
  const blocks: DisplayLine[] = [];
  for (const row of visible) {
    const last = blocks.at(-1);
    if (row.kind !== "omitted" && last && last.kind === row.kind) last.lines.push(row.text);
    else if (row.kind === "omitted") blocks.push(row);
    else blocks.push({ kind: row.kind, lines: [row.text] });
  }
  if (blocks.length <= MAX_DISPLAY_ROWS) return { rows: blocks, added, removed, truncated: false };
  const half = MAX_DISPLAY_ROWS / 2;
  return {
    rows: [...blocks.slice(0, half), { kind: "omitted", count: blocks.length - MAX_DISPLAY_ROWS }, ...blocks.slice(-half)],
    added, removed, truncated: true,
  };
}

export function questionLines(questions: readonly { question: string; answer?: string }[]): string[] {
  return questions.flatMap((item, index) => {
    const question = textLines(item.question);
    const answer = item.answer === undefined ? ["(unanswered)"] : textLines(item.answer);
    return [
      ...question.map((line, part) => `${part ? "  " : `Question ${index + 1}: `}${line}`),
      ...answer.map((line, part) => `${part ? "  " : `Answer ${index + 1}: `}${line}`),
    ];
  });
}

/** Preserve statement boundaries even when one stored statement contains a newline. */
export function pinnedLines(statements: readonly string[]): string[] {
  return statements.flatMap((statement, index) => {
    const lines = textLines(statement);
    if (!lines.length) return [`Statement ${index + 1}: (blank)`];
    return lines.map((line, part) => `${part ? "  " : `Statement ${index + 1}: `}${line}`);
  });
}
