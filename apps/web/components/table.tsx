import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from "react";

export function Table({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto border-2 border-line">
      <table className={`w-full min-w-[720px] border-collapse text-14 ${className}`}>{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="bg-sunken text-left">{children}</thead>;
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>;
}

/** `highlighted` is the keyboard cursor: a 4px inset rule down the left edge. */
export function TR({ children, className = "", highlighted = false }: { children: ReactNode; className?: string; highlighted?: boolean }) {
  return (
    <tr
      className={`border-t border-line-faint ${highlighted ? "bg-highlight inset-shadow-cursor" : "hover:bg-sunken"} ${className}`}
    >
      {children}
    </tr>
  );
}

export function TH({ children, className = "", ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th scope="col" className={`ds-pixel border-b-2 border-line px-3 py-2 text-9 tracking-th text-muted ${className}`} {...rest}>
      {children}
    </th>
  );
}

export function TD({ children, className = "", ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={`px-3 py-2 align-top text-fg ${className}`} {...rest}>
      {children}
    </td>
  );
}

/**
 * Fit as ten stepped cells, never a smooth bar: the score is a model estimate
 * on a coarse scale and the shape should say so. `title` carries the stored
 * rationale, so hovering the score explains it without expanding the row (R-6.7).
 */
export function FitBar({ score, title }: { score: number | null; title?: string }) {
  if (score === null) return <span className="text-muted" title={title}>—</span>;
  const filled = Math.round(Math.max(0, Math.min(100, score)) / 10);
  const tone = score >= 70 ? "bg-ok" : score >= 30 ? "bg-warn" : "bg-danger";
  return (
    <div className="flex items-center gap-2" title={title}>
      <span className="ds-pixel w-6 text-right text-10 text-fg">{score}</span>
      <span className="flex gap-0.5" aria-hidden="true">
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className={`h-2 w-1.5 ${i < filled ? tone : "bg-track"}`} />
        ))}
      </span>
    </div>
  );
}
