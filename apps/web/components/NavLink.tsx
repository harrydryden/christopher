"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function NavLink({
  href,
  children,
  count = null,
  countTitle,
}: {
  href: string;
  children: ReactNode;
  /** A figure beside the label, shown only when there is something to show. */
  count?: number | null;
  /** What the figure counts, for whoever hovers or reads it out. */
  countTitle?: string;
}) {
  const pathname = usePathname();
  // A sidebar entry owns every page its section reaches, so the CV workspace keeps Applications
  // lit and Health, Learning and Account keep Settings lit.
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href) || (href === "/companies" && pathname === "/suggestions") || (href === "/applications" && pathname.startsWith("/cv")) || (href === "/settings" && ["/learning", "/account", "/health"].includes(pathname));
  return (
    <Link prefetch={false}
      href={href}
      aria-current={active ? "page" : undefined}
      className={`ds-pixel flex items-center justify-between gap-2 border-2 px-3 py-1.5 text-11 no-underline ${
        active ? "border-fg bg-fg text-bg" : "border-transparent text-fg hover:bg-sunken"
      }`}
    >
      <span>{children}</span>
      {count !== null && count > 0 && <span className="tabular-nums" title={countTitle} aria-label={countTitle}>{count}</span>}
    </Link>
  );
}
