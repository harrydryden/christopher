"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Mark } from "@/components/brand";

/** One navigation tree: always visible on desktop, an explicit compact disclosure on phones. */
export function WorkspaceMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);
  return <aside className="ds-on-brand w-full shrink-0 p-3 md:flex md:w-48 md:flex-col" onKeyDown={event => {
    if (event.key === "Escape" && open) { setOpen(false); button.current?.focus(); }
  }}>
    <div className="flex items-center justify-between gap-3 md:mb-4">
      <Link prefetch={false} href="/" className="flex min-h-11 items-center text-brand-ink" aria-label="AVA home"><Mark size={28} /></Link>
      <button ref={button} type="button" aria-controls="workspace-menu" aria-expanded={open}
        onClick={() => setOpen(value => !value)} className="min-h-11 border-2 border-brand-ink px-3 text-14 font-semibold md:hidden">
        {open ? "Close menu" : "Menu"}
      </button>
    </div>
    <div id="workspace-menu" className={`${open ? "flex" : "hidden"} flex-1 flex-col pt-3 md:flex md:pt-0`}>{children}</div>
  </aside>;
}
