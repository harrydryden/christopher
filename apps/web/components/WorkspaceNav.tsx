"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
// Applications has no group: every company-role being pursued, and the CV in its row, is one
// table on one page, so there is nothing for a section tab to move between.
const groups = [
  [["/companies", "Tracked companies"], ["/suggestions", "Discover companies"]],
  [["/settings", "Preferences"], ["/learning", "Learning and feedback"], ["/health", "Health"], ["/account", "Account"]],
  [["/admin", "Accounts"], ["/admin/settings", "System settings"], ["/admin/catalogue", "Company catalogue"], ["/admin/health", "Operations"]],
];
export function WorkspaceNav() {
  const path = usePathname();
  const group = groups.find(items => items.some(([href]) => path === href || path.startsWith(href + "/")));
  if (!group) return null;
  return <nav aria-label="Workspace sections" className="ds-divider mb-5 flex flex-wrap gap-4 pb-3 text-13">{group.map(([href, label]) => <Link key={href} href={href!} aria-current={path === href ? "page" : undefined} className={path === href ? "font-semibold text-fg underline decoration-2 underline-offset-4" : "text-muted no-underline hover:underline"}>{label}</Link>)}</nav>;
}
