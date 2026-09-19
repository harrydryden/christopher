/**
 * Tiny, safe markdown renderer: headings (#, ##, ###), paragraphs, bullet lists and `**bold**`.
 * No HTML parsing at all — every piece of text passes through as ordinary React children,
 * which React escapes automatically, so nothing in the profile text can render as markup.
 *
 * Inline runs come from the notepad's grammar (lib/notes-markdown), so a company note renders
 * here exactly as it was typed, escapes and all.
 */
import { parseRuns } from "@/lib/notes-markdown";

/** The inline layer: bold runs become `<strong>`, everything else is text. */
function Inline({ text }: { text: string }) {
  const runs = parseRuns(text);
  return <>{runs.map((run, i) => (run.bold ? <strong key={i} className="font-semibold">{run.text}</strong> : <span key={i}>{run.text}</span>))}</>;
}

type MdBlock = { type: "heading"; level: 1 | 2 | 3; text: string } | { type: "list"; items: string[] } | { type: "paragraph"; lines: string[] };

function parseBlocks(markdown: string): MdBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3;
      blocks.push({ type: "heading", level, text: heading[2]!.trim() });
      i++;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^[-*]\s+/, "").trim());
        i++;
      }
      blocks.push({ type: "list", items });
      continue;
    }
    const paraLines: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "" && !/^(#{1,3})\s+/.test(lines[i] ?? "") && !/^[-*]\s+/.test(lines[i] ?? "")) {
      paraLines.push((lines[i] ?? "").trim());
      i++;
    }
    blocks.push({ type: "paragraph", lines: paraLines });
  }
  return blocks;
}

export function SafeMarkdown({ markdown, className = "" }: { markdown: string; className?: string }) {
  const blocks = parseBlocks(markdown);
  if (blocks.length === 0) return null;
  return (
    <div className={`space-y-2.5 text-14 leading-relaxed text-fg ${className}`}>
      {blocks.map((b, i) => {
        if (b.type === "heading") {
          if (b.level === 1) return <h3 key={i} className="mt-4 text-14 font-semibold text-fg first:mt-0"><Inline text={b.text} /></h3>;
          if (b.level === 2) return <h4 key={i} className="mt-3 text-14 font-semibold text-fg"><Inline text={b.text} /></h4>;
          return <h5 key={i} className="mt-2 text-14 font-medium text-fg"><Inline text={b.text} /></h5>;
        }
        if (b.type === "list") {
          return (
            <ul key={i} className="list-disc space-y-0.5 pl-5">
              {b.items.map((item, j) => (
                <li key={j}><Inline text={item} /></li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i}>
            {b.lines.map((line, j) => (
              <span key={j}>
                <Inline text={line} />
                {j < b.lines.length - 1 && <br />}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
