import { WorkspaceShell } from "@/components/WorkspaceShell";
import { NavigationMetrics } from "@/components/NavigationMetrics";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { logout } from "@/app/login/actions";
import { WorkspaceNav } from "@/components/WorkspaceNav";
import { NavLink } from "@/components/NavLink";
import { getLatestScanRun } from "@/lib/queries/companies";
import { getSettings } from "@/lib/settings";
import { localDateParts } from "@christopher/core";
import type { ScanRun } from "@christopher/db/schema";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function scanBanner(run: ScanRun | null, tz: string, now: Date): { text: string; href: string | null } {
  if (!run) return { text: "No scans yet", href: null };
  const parts = localDateParts(run.startedAt, tz);
  const today = localDateParts(now, tz);
  const [, month, day] = parts.ymd.split("-");
  const dayLabel = parts.ymd === today.ymd ? "Today" : `${WEEKDAYS[parts.weekday]} ${Number(day)}/${Number(month)}`;
  const roleWord = run.newRoles === 1 ? "role" : "roles";
  const text = `${dayLabel} ${parts.hm} · ${run.companiesOk} of ${run.companiesTotal} companies OK · ${run.newRoles} new ${roleWord}`;
  return { text, href: run.companiesFailed > 0 ? "/health" : null };
}

const NAV_ITEMS = [
  { href: "/", label: "Roles" },
  { href: "/companies", label: "Companies" },
  { href: "/cv", label: "CVs" },
  { href: "/applications", label: "Applications" },
  { href: "/settings", label: "Settings" },
];

async function ScanBanner() {
  const [settings, latestRun] = await Promise.all([getSettings(), getLatestScanRun()]);
  const banner = scanBanner(latestRun, settings.timezone, new Date());
  return banner.href ? <Link href={banner.href} className="underline decoration-dotted">{banner.text}</Link> : <span>{banner.text}</span>;
}
export default function AppLayout({ children }: { children: ReactNode }) {

  return (
    <WorkspaceShell><NavigationMetrics />
      <div className="scan-banner border-b border-white/20 px-4 py-2 text-sm">
        <Suspense fallback={<span>Loading scan status…</span>}><ScanBanner /></Suspense>
      </div>
      <div className="flex flex-1 flex-col md:flex-row">
        <aside className="app-sidebar w-full shrink-0 border-b border-white/20 p-3 md:w-48 md:border-b-0 md:border-r">
          <div className="mb-4 px-2 text-base font-semibold text-white">Christopher</div>
          <nav aria-label="Main navigation" className="flex flex-wrap gap-1 md:block md:space-y-0.5">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.href} href={item.href}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <form action={logout} className="mt-4 px-2">
            <button type="submit" className="text-sm text-white hover:underline">
              Logout
            </button>
          </form>
        </aside>
        <main className="min-w-0 flex-1 p-4 md:p-6"><WorkspaceNav />{children}</main>
      </div>
    </WorkspaceShell>
  );
}
