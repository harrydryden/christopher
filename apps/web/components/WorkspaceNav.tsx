"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { workspaceSections } from "@/lib/workspace-navigation";
// Applications has no group: every company-role being pursued, and the CV in its row, is one
// table on one page, so there is nothing for a section tab to move between.
export function WorkspaceNav() {
  const path = usePathname();
  const group = workspaceSections(path);
  if (!group) return null;
  return <nav aria-label="Workspace sections" className="ds-divider mb-5 flex flex-wrap gap-4 pb-3 text-13">{group.map(([href, label]) => <Link prefetch={false} key={href} href={href!} aria-current={path === href ? "page" : undefined} className={`inline-flex min-h-11 items-center ${path === href ? "font-semibold text-fg underline decoration-2 underline-offset-4" : "text-muted no-underline hover:underline"}`}>{label}</Link>)}</nav>;
}
