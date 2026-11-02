/** Jobs and their existing routes share one navigation map on server and client. */
export const PRIMARY_NAV_ITEMS = [
  { href: "/", label: "Find roles" },
  { href: "/applications", label: "Applications" },
  { href: "/library", label: "Experience" },
] as const;

export const SECONDARY_NAV_ITEMS = [
  { href: "/settings", label: "Preferences" },
  { href: "/health", label: "Needs attention" },
] as const;

const FIND_ROLES_SECTIONS = [["/", "Matches"], ["/companies", "Following"], ["/suggestions", "Discover companies"]] as const;
const PREFERENCES_SECTIONS = [["/settings", "Preferences"], ["/learning", "Search profile"]] as const;
const ADMIN_SECTIONS = [["/admin", "Accounts"], ["/admin/settings", "System settings"], ["/admin/catalogue", "Company catalogue"], ["/admin/health", "Operations"]] as const;

const within = (path: string, route: string) => path === route || path.startsWith(`${route}/`);
const findingRoles = (path: string) => path === "/" || within(path, "/roles") || within(path, "/companies") || within(path, "/suggestions");

export function workspaceNavActive(href: string, path: string): boolean {
  if (href === "/") return findingRoles(path);
  if (href === "/applications") return within(path, href) || within(path, "/cv");
  if (href === "/settings") return within(path, href) || within(path, "/learning") || within(path, "/account");
  return within(path, href);
}

export function workspaceSections(path: string): ReadonlyArray<readonly [string, string]> | null {
  if (findingRoles(path)) return FIND_ROLES_SECTIONS;
  if (within(path, "/settings") || within(path, "/learning")) return PREFERENCES_SECTIONS;
  if (within(path, "/admin")) return ADMIN_SECTIONS;
  return null;
}
