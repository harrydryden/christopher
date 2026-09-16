"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
const groups = [
  [["/companies", "Tracked companies"], ["/suggestions", "Discover companies"]],
  [["/settings", "Preferences"], ["/learning", "Learning and feedback"], ["/health", "System health"], ["/account", "Account"]],
];
export function WorkspaceNav() {
  const path = usePathname();
  const group = groups.find(items => items.some(([href]) => path === href || path.startsWith(href + "/")));
  if (!group) return null;
  return <nav aria-label="Workspace sections" className="ds-divider mb-5 flex flex-wrap gap-4 pb-3 text-13">{group.map(([href, label]) => <Link key={href} href={href!} aria-current={path === href ? "page" : undefined} className={path === href ? "font-semibold text-fg underline decoration-2 underline-offset-4" : "text-muted no-underline hover:underline"}>{label}</Link>)}</nav>;
}
