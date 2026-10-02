import { WorkspaceShell } from "@/components/WorkspaceShell";
import { WorkspaceMenu } from "@/components/WorkspaceMenu";
import { NavigationMetrics } from "@/components/NavigationMetrics";
import { ScanStatusBanner } from "@/components/ScanStatusBanner";
import { getScanStatus } from "@/lib/scan-status";
import { countHealthItems } from "@/lib/queries/health";
import { getCurrentUser, needsEmailConfirmation } from "@/lib/auth";
import { Suspense, type ReactNode } from "react";
import { logout } from "@/app/login/actions";
import { resendVerification } from "@/app/actions/account";
import { WorkspaceNav } from "@/components/WorkspaceNav";
import { PlanReadout } from "@/components/BillingOverview";
import { getBillingSummary } from "@/lib/billing/service";
// The banner and every control it disables say one sentence, from one place.
import { VERIFY_SENTENCE } from "@/components/VerifyNotice";
import { NavLink } from "@/components/NavLink";
import { Monogram } from "@/components/brand";
import Link from "next/link";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";

/** One entry for applications and CVs: the two are one job, on one page, under one heading. */
const NAV_ITEMS: Array<{ href: string; label: string }> = [
  { href: "/", label: "Roles" },
  { href: "/companies", label: "Companies" },
  { href: "/applications", label: "Applications" },
  { href: "/library", label: "Library" },
  { href: "/learning", label: "Learning" },
  { href: "/health", label: "Health" },
  { href: "/settings", label: "Settings" },
];

/** Attention leads straight to its resolution, without blocking the rest of the shell. */
async function HealthNavLink({ userId, href, children }: { userId: string; href: string; children: ReactNode }) {
  const count = await countHealthItems(userId);
  return <NavLink href={href} count={count} countTitle={`${count} ${count === 1 ? "item" : "items"} on Health need${count === 1 ? "s" : ""} you`}>{children}</NavLink>;
}

async function ScanBanner({ userId }: { userId: string }) {
  const status = await getScanStatus(userId);
  return <ScanStatusBanner initial={status} />;
}

async function BillingReadout({ pending, mobile = false }: { pending: ReturnType<typeof getBillingSummary>; mobile?: boolean }) {
  return <PlanReadout billing={await pending} mobile={mobile} />;
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Middleware only checks the cookie's signature; a revoked session is refused here.
  const current = await getCurrentUser();
  if (!current) redirect("/login?error=signed_out");
  const { user } = current;
  const billing = getBillingSummary(user.id);

  return (
    <WorkspaceShell><NavigationMetrics />
      <a href="#main-content" className="sr-only focus:not-sr-only focus:bg-bg focus:p-3 focus:text-fg">Skip to main content</a>
      <div className="flex items-center gap-3 border-b border-line-muted bg-raised px-4 py-2 text-13">
        <Monogram size={16} />
        <Suspense fallback={<span className="text-muted">Loading scan status…</span>}><ScanBanner userId={user.id} /></Suspense>
      </div>
      {needsEmailConfirmation(user) && (
        <div className="flex flex-wrap items-center gap-3 border-b border-line-muted bg-sunken px-4 py-2 text-13" role="status">
          <span>{VERIFY_SENTENCE} The link asks for your password.</span>
          <form action={resendVerification}>
            <button type="submit" className="min-h-11 underline">Send the link again</button>
          </form>
        </div>
      )}
      <div className="flex flex-1 flex-col md:flex-row">
        <WorkspaceMenu mobilePlan={<Suspense fallback={null}><BillingReadout pending={billing} mobile /></Suspense>}>
          <nav aria-label="Main navigation" className="flex flex-wrap gap-0.5 md:block md:space-y-0.5">
            {[...NAV_ITEMS, ...(user.role === "admin" ? [{ href: "/admin", label: "Admin" }] : [])].map((item) => item.href === "/health" ? (
              <Suspense key={item.href} fallback={<NavLink href={item.href}>{item.label}</NavLink>}>
                <HealthNavLink userId={user.id} href={item.href}>{item.label}</HealthNavLink>
              </Suspense>
            ) : (
              <NavLink key={item.href} href={item.href}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="mt-auto space-y-2 px-2 pt-4 text-13">
            <div className="hidden md:block"><Suspense fallback={null}><BillingReadout pending={billing} /></Suspense></div>
            <Link prefetch={false} href="/account" className="flex min-h-11 items-center truncate text-brand-ink-muted no-underline hover:text-brand-ink hover:underline" title={user.email}>
              {user.name || user.email}
              {user.role === "admin" && <span className="ml-1 text-11 text-brand-ink-muted">admin</span>}
            </Link>
            <form action={logout}>
              <button type="submit" className="min-h-11 text-brand-ink underline">
                Sign out
              </button>
            </form>
          </div>
        </WorkspaceMenu>
        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 p-4 md:p-6"><WorkspaceNav />{children}</main>
      </div>
    </WorkspaceShell>
  );
}
