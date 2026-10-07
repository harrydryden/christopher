"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** Purchase links arrive from credit/capacity prompts elsewhere in the app. Open their destination
 * even when it is normally secondary, including a same-page anchor navigation. */
export function AccountDisclosure({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function reveal() {
      if (window.location.hash !== `#${id}` || !ref.current) return;
      ref.current.open = true;
      ref.current.scrollIntoView?.({ block: "start" });
    }
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [id]);
  return <details ref={ref} id={id} className="scroll-mt-4 border border-line-faint bg-raised">
    <summary className="min-h-11 cursor-pointer px-4 py-3 font-semibold">{title}</summary>
    <div className="border-t border-line-faint">{children}</div>
  </details>;
}
