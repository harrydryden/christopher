"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href) || (href === "/companies" && pathname === "/suggestions") || (href === "/settings" && ["/learning", "/health"].includes(pathname));
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`block rounded-md px-3 py-1.5 text-sm font-medium ${
        active
          ? "bg-white/15 text-white ring-1 ring-inset ring-white/40"
          : "text-white hover:bg-white/10"
      }`}
    >
      {children}
    </Link>
  );
}
