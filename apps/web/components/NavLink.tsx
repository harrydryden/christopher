"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  // A sidebar entry owns every page its section reaches, so the CV workspace keeps Applications lit.
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href) || (href === "/companies" && pathname === "/suggestions") || (href === "/applications" && pathname.startsWith("/cv")) || (href === "/settings" && ["/learning", "/health", "/account"].includes(pathname));
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`ds-pixel block border-2 px-3 py-1.5 text-11 no-underline ${
        active ? "border-fg bg-fg text-bg" : "border-transparent text-fg hover:bg-sunken"
      }`}
    >
      {children}
    </Link>
  );
}
