"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
const groups = [
  [["/companies", "Tracked companies"], ["/suggestions", "Discover companies"]],
  [["/cv", "Build and review CVs"], ["/cv/library", "Evidence and writing preferences"]],
  [["/settings", "Preferences"], ["/learning", "Learning and feedback"], ["/health", "System health"]],
];
export function WorkspaceNav() {
  const path = usePathname();
  const group = groups.find(items => items.some(([href]) => path === href || path.startsWith(href + "/")));
  if (!group) return null;
  return <nav aria-label="Workspace sections" className="mb-5 flex flex-wrap gap-3 border-b border-slate-700 pb-3 text-sm">{group.map(([href, label]) => <Link key={href} href={href!} aria-current={path === href ? "page" : undefined} className={path === href ? "font-semibold underline" : "text-slate-500"}>{label}</Link>)}</nav>;
}
