import Link from "next/link";
import type { ReactNode } from "react";
import { logout } from "@/app/login/actions";
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
  { href: "/suggestions", label: "Suggestions" },
  { href: "/learning", label: "Learning" },
  { href: "/health", label: "Health" },
  { href: "/settings", label: "Settings" },
];

export default async function AppLayout({ children }: { children: ReactNode }) {
  const [settings, latestRun] = await Promise.all([getSettings(), getLatestScanRun()]);
  const banner = scanBanner(latestRun, settings.timezone, new Date());

  return (
    <div className="flex min-h-screen flex-col">
      <div className="border-b border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
        {banner.href ? (
          <Link href={banner.href} className="underline decoration-dotted underline-offset-2 hover:text-slate-900 dark:hover:text-slate-100">
            {banner.text}
          </Link>
        ) : (
          <span>{banner.text}</span>
        )}
      </div>
      <div className="flex flex-1">
        <aside className="w-48 shrink-0 border-r border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-4 px-2 text-base font-semibold text-slate-900 dark:text-slate-100">Christopher</div>
          <nav className="space-y-0.5">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.href} href={item.href}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <form action={logout} className="mt-4 px-2">
            <button type="submit" className="text-sm text-slate-500 hover:text-slate-800 hover:underline dark:text-slate-400 dark:hover:text-slate-100">
              Logout
            </button>
          </form>
        </aside>
        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
