import { WorkspaceShell } from "@/components/WorkspaceShell";
import { NavigationMetrics } from "@/components/NavigationMetrics";
import { ScanStatusBanner } from "@/components/ScanStatusBanner";
import { getScanStatus } from "@/lib/scan-status";
import { getCurrentUser, needsEmailConfirmation } from "@/lib/auth";
import { Suspense, type ReactNode } from "react";
import { logout } from "@/app/login/actions";
import { resendVerification } from "@/app/actions/account";
import { WorkspaceNav } from "@/components/WorkspaceNav";
import { NavLink } from "@/components/NavLink";
import { Mark } from "@/components/brand";
import Link from "next/link";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";

/** One entry for applications and CVs: the two are one job, and the section tabs separate them. */
const NAV_ITEMS = [
  { href: "/", label: "Roles" },
  { href: "/companies", label: "Companies" },
  { href: "/applications", label: "Applications" },
  { href: "/library", label: "Library" },
  { href: "/settings", label: "Settings" },
];

async function ScanBanner({ userId }: { userId: string }) {
  const status = await getScanStatus(userId);
  return <ScanStatusBanner initialText={status.text} />;
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Middleware only checks the cookie's signature; a revoked session is refused here.
  const current = await getCurrentUser();
  if (!current) redirect("/login?error=signed_out");
  const { user } = current;

  return (
    <WorkspaceShell><NavigationMetrics />
      <div className="flex items-center gap-3 border-b-2 border-line bg-raised px-4 py-2 text-13">
        <Mark size={16} />
        <Suspense fallback={<span className="text-muted">Loading scan status…</span>}><ScanBanner userId={user.id} /></Suspense>
      </div>
      {needsEmailConfirmation(user) && (
        <div className="flex flex-wrap items-center gap-3 border-b-2 border-line bg-sunken px-4 py-2 text-13" role="status">
          <span>Confirm your email address to add companies, run discovery and build CVs. The link asks for your password.</span>
          <form action={resendVerification}>
            <button type="submit" className="underline">Send the link again</button>
          </form>
        </div>
      )}
      <div className="flex flex-1 flex-col md:flex-row">
        <aside className="flex w-full shrink-0 flex-col border-b-2 border-line p-3 md:w-48 md:border-b-0 md:border-r-2">
          <Link href="/" className="mb-4 block p-2" aria-label="Christopher home">
            <Mark size={48} />
          </Link>
          <nav aria-label="Main navigation" className="flex flex-wrap gap-0.5 md:block md:space-y-0.5">
            {[...NAV_ITEMS, ...(user.role === "admin" ? [{ href: "/admin", label: "Admin" }] : [])].map((item) => (
              <NavLink key={item.href} href={item.href}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="mt-auto space-y-2 px-2 pt-4 text-13">
            <Link href="/account" className="block truncate text-muted no-underline hover:underline" title={user.email}>
              {user.name || user.email}
              {user.role === "admin" && <span className="ml-1 text-11 text-faint">admin</span>}
            </Link>
            <form action={logout}>
              <button type="submit" className="underline">
                Sign out
              </button>
            </form>
          </div>
        </aside>
        <main className="min-w-0 flex-1 p-4 md:p-6"><WorkspaceNav />{children}</main>
      </div>
    </WorkspaceShell>
  );
}
