/**
 * Tiny, safe markdown renderer: headings (#, ##, ###), paragraphs and bullet lists only.
 * No HTML parsing at all — every piece of text passes through as ordinary React children,
 * which React escapes automatically, so nothing in the profile text can render as markup.
 */

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
    <div className={`space-y-2.5 text-sm leading-relaxed text-slate-700 dark:text-slate-300 ${className}`}>
      {blocks.map((b, i) => {
        if (b.type === "heading") {
          if (b.level === 1) return <h3 key={i} className="mt-4 text-base font-semibold text-slate-900 first:mt-0 dark:text-slate-100">{b.text}</h3>;
          if (b.level === 2) return <h4 key={i} className="mt-3 text-sm font-semibold text-slate-900 dark:text-slate-100">{b.text}</h4>;
          return <h5 key={i} className="mt-2 text-sm font-medium text-slate-800 dark:text-slate-200">{b.text}</h5>;
        }
        if (b.type === "list") {
          return (
            <ul key={i} className="list-disc space-y-0.5 pl-5">
              {b.items.map((item, j) => (
                <li key={j}>{item}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i}>
            {b.lines.map((line, j) => (
              <span key={j}>
                {line}
                {j < b.lines.length - 1 && <br />}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
