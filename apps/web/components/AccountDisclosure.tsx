import type { ReactNode } from "react";

/** Account tasks stay visible; anchor links work without hydration or disclosure state. */
export function AccountDisclosure({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-4 border border-line-faint bg-raised">
    <h2 id={`${id}-heading`} className="px-4 py-3 font-semibold">{title}</h2>
    <div className="border-t border-line-faint">{children}</div>
  </section>;
}
