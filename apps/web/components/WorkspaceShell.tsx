"use client";
import { usePathname } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";
import { DEFAULT_CV_THEME } from "@christopher/core/cv";

/** CV screens use the document's default palette, independently of OS dark mode. */
export function WorkspaceShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const cv = path === "/cv" || path.startsWith("/cv/");
  return <div data-cv-light={cv ? "" : undefined} className="flex min-h-screen flex-col" style={cv ? { "--cv-navy": DEFAULT_CV_THEME.primary } as CSSProperties : undefined}>{children}</div>;
}
