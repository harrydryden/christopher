"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function NavLink({
  href,
  children,
  count = null,
  countTitle,
  secondary = false,
}: {
  href: string;
  children: ReactNode;
  /** A figure beside the label, shown only when there is something to show. */
  count?: number | null;
  /** What the figure counts, for whoever hovers or reads it out. */
  countTitle?: string;
  secondary?: boolean;
}) {
  const pathname = usePathname();
  // The sidebar is brand green: the lit entry is a light-green block with green text, the others
  // light-green text that darkens the green under them on hover.
  // A sidebar entry owns every page its section reaches, so the CV workspace keeps Applications
  // lit; Health and Learning have their own entries, and Account keeps Settings lit.
  const active = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`) || (href === "/companies" && pathname === "/suggestions") || (href === "/applications" && pathname.startsWith("/cv")) || (href === "/settings" && pathname === "/account");
  const showCount = count !== null && count > 0;
  // A named count describes the link rather than naming it: the entry keeps its plain label to a
  // reader and to anything that finds it by name, and the figure's meaning follows as its
  // description. The bare figure stays in the name when nothing names it.
  const descriptionId = showCount && countTitle ? `nav-count-${href.replace(/[^a-z0-9]+/gi, "-")}` : undefined;
  return (
    <Link prefetch={false}
      href={href}
      aria-current={active ? "page" : undefined}
      aria-describedby={descriptionId}
      className={`flex min-h-11 items-center justify-between gap-2 border-2 px-3 py-2 no-underline ${secondary ? "text-13" : "text-14 font-semibold"} ${
        active ? "border-brand-ink bg-brand-ink text-brand" : "border-transparent text-brand-ink hover:bg-brand-hover"
      }`}
    >
      <span>{children}</span>
      {showCount && <span className="tabular-nums" title={countTitle} aria-hidden={descriptionId ? true : undefined}>{count}</span>}
      {descriptionId && <span id={descriptionId} hidden>{countTitle}</span>}
    </Link>
  );
}
