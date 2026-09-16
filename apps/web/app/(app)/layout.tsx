import { WorkspaceShell } from "@/components/WorkspaceShell";
import { NavigationMetrics } from "@/components/NavigationMetrics";
import { ScanStatusBanner } from "@/components/ScanStatusBanner";
import { getScanStatus } from "@/lib/scan-status";
import { Suspense, type ReactNode } from "react";
import { logout } from "@/app/login/actions";
import { WorkspaceNav } from "@/components/WorkspaceNav";
import { NavLink } from "@/components/NavLink";
import { Mark } from "@/components/brand";
import Link from "next/link";
export const dynamic = "force-dynamic";

const NAV_ITEMS = [
  { href: "/", label: "Roles" },
  { href: "/companies", label: "Companies" },
  { href: "/cv", label: "CVs" },
  { href: "/library", label: "Library" },
  { href: "/applications", label: "Applications" },
  { href: "/settings", label: "Settings" },
];

async function ScanBanner() {
  const status = await getScanStatus();
  return <ScanStatusBanner initialText={status.text} />;
}

export default function AppLayout({ children }: { children: ReactNode }) {

  return (
    <WorkspaceShell><NavigationMetrics />
      <div className="flex items-center gap-3 border-b-2 border-line bg-raised px-4 py-2 text-13">
        <Mark size={16} />
        <Suspense fallback={<span className="text-muted">Loading scan status…</span>}><ScanBanner /></Suspense>
      </div>
      <div className="flex flex-1 flex-col md:flex-row">
        <aside className="flex w-full shrink-0 flex-col border-b-2 border-line p-3 md:w-48 md:border-b-0 md:border-r-2">
          <Link href="/" className="mb-4 block p-2" aria-label="Christopher home">
            <Mark size={48} />
          </Link>
          <nav aria-label="Main navigation" className="flex flex-wrap gap-0.5 md:block md:space-y-0.5">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.href} href={item.href}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <form action={logout} className="mt-auto px-2 pt-4">
            <button type="submit" className="text-13 underline">
              Logout
            </button>
          </form>
        </aside>
        <main className="min-w-0 flex-1 p-4 md:p-6"><WorkspaceNav />{children}</main>
      </div>
    </WorkspaceShell>
  );
}
