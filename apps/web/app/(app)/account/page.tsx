import { changePassword, resendVerification, signOutEverywhere, updateProfile } from "@/app/actions/account";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { inputClass, labelClass } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { AuthSubmitButton } from "@/components/AuthSubmitButton";
import { BillingOverview } from "@/components/BillingOverview";
import { LinkedInDisconnectControl } from "@/components/LinkedInDisconnectControl";
import { SettingsForm } from "@/components/SettingsForm";
import { linkedProviders } from "@/lib/accounts";
import { getCurrentUser, needsEmailConfirmation } from "@/lib/auth";
import { emailConfigured } from "@/lib/email";
import { googleConfigured } from "@/lib/google";
import { linkedinConfigured } from "@/lib/linkedin";
import { MIN_PASSWORD_LENGTH } from "@col/core";
import { getBillingSummary } from "@/lib/billing/service";
import { addCompanyCapacity, openBillingPortal, startCreditCheckout, startPlanCheckout } from "@/app/actions/billing";
import { getCompanyCapacityQuote } from "@/lib/billing/company-capacity";
import { redirect } from "next/navigation";
import { sanitizeNextPath } from "@/lib/session";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

const NOTICES: Record<string, string> = {
  reset: "Your password has been reset and every other browser has been signed out.",
  "verify:done": "Your email address is confirmed.",
  "verify:sent": "A new confirmation link was sent. Check your inbox.",
  "verify:invalid": "That confirmation link is no longer valid. Send a new one below.",
  "verify:required": "Confirm your email address before adding companies, running discovery or building CVs. The link asks for your password.",
  "verify:delivery_failed": "We could not send your confirmation link. Try again below; if it still does not arrive, ask an administrator for help.",
  "verify:rate_limited": "Too many confirmation requests. Wait an hour before trying again.",
  "billing:plan_started": "Checkout complete. Your plan will appear here once payment is confirmed.",
  "billing:credits_added": "Checkout complete. Your CV credits will appear here once payment is confirmed.",
  "billing:cancelled": "Checkout closed. No purchase was made.",
  "billing:setup_required": "Purchases are unavailable here at the moment. Please try again later.",
  "billing:unknown_plan": "That plan is unavailable. Choose one of the plans below.",
  "billing:unknown_pack": "That credit pack is unavailable. Choose one of the packs below.",
  "billing:checkout_failed": "Checkout could not start. Please try again.",
  "billing:no_customer": "No billing account is linked to this plan yet.",
  "billing:manage_existing": "Use Manage plan to change an existing paid subscription.",
  "billing:capacity_added": "Ten more company places were added to your plan.",
  "billing:capacity_quote_expired": "That capacity quote expired. Review the current price below and confirm again.",
  "billing:capacity_failed": "Company capacity could not be changed. Review your payment method or try again.",
};

async function AccountBilling({ userId }: { userId: string }) {
  const [billing, capacityQuote] = await Promise.all([
    getBillingSummary(userId), getCompanyCapacityQuote(userId).catch(() => null),
  ]);
  return <BillingOverview billing={billing} capacityQuote={capacityQuote}
    actions={{ addCompanyCapacity, openBillingPortal, startCreditCheckout, startPlanCheckout }} />;
}

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ reset?: string; verify?: string; billing?: string; next?: string }> }) {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const { user } = current;
  const sp = await searchParams;
  const next = sp.next ? sanitizeNextPath(sp.next) : null;
  // `?verify=required` outlives the redirect that set it, so the notice it names is shown only
  // while that account really is held back.
  const key = sp.reset ? "reset" : sp.verify ? `verify:${sp.verify}` : sp.billing ? `billing:${sp.billing}` : null;
  const notice = key && (key !== "verify:required" || needsEmailConfirmation(user)) ? NOTICES[key] : null;
  const providers = await linkedProviders(user.id);
  const canReauthenticateWithGoogle = googleConfigured() && providers.some(p => p.provider === "google");
  const canReauthenticateWithLinkedIn = linkedinConfigured() && providers.some(p => p.provider === "linkedin");
  const labelClassName = "flex flex-col gap-1.5 text-14";

  return (
    <div className="space-y-6">
      <PageHeader title="Account" />
      {notice && <p role="status" className={`border-2 px-3 py-2 text-14 ${sp.verify === "required" || sp.verify === "invalid" || sp.verify === "delivery_failed" || sp.verify === "rate_limited" ? "border-warn text-warn" : "border-ok text-ok"}`}>{notice}</p>}

      <Card title="Profile">
        <SettingsForm action={updateProfile}>
          <label className={labelClassName}>
            <span className={labelClass}>Name</span>
            <input name="name" defaultValue={user.name ?? ""} maxLength={200} className={`max-w-sm ${inputClass}`} />
          </label>
          <p className="text-14 text-muted">
            Email: <span className="text-fg">{user.email}</span>{" "}
            {user.emailVerifiedAt ? <Badge tone="green">verified</Badge> : <Badge tone="amber">unverified</Badge>}
            {" · "}Role: <span className="text-fg">{user.role}</span>
          </p>
        </SettingsForm>
        {!user.emailVerifiedAt && emailConfigured() && (
          <form action={resendVerification} className="mt-3 flex flex-wrap items-center gap-3">
            {next && <input type="hidden" name="next" value={next} />}
            <AuthSubmitButton label="Send confirmation email" pendingLabel="Sending…" size="sm" className="" />
            <span className="text-12 text-muted">The link asks for your password.</span>
          </form>
        )}
        {!user.emailVerifiedAt && !emailConfigured() && <p className="mt-3 text-13 text-warn">Confirmation email is temporarily unavailable. Ask an administrator for help.</p>}
      </Card>

      <Suspense fallback={<p role="status" className="text-13 text-muted">Loading plan and credits…</p>}>
        <AccountBilling userId={user.id} />
      </Suspense>

      <Card title={user.passwordHash ? "Change password" : "Set a password"}>
        <SettingsForm action={changePassword} submitLabel={user.passwordHash ? "Change password" : "Set password"}>
          {user.passwordHash ? (
            <label className={labelClassName}>
              <span className={labelClass}>Current password</span>
              <input name="currentPassword" type="password" required autoComplete="current-password" className={`max-w-sm ${inputClass}`} />
            </label>
          ) : (
            <div className="space-y-2 text-14 text-muted">
              <p>A password lets you sign in with your email. Setting your first one needs a recent sign-in to this account.</p>
              {user.emailVerifiedAt ? <>
                {(canReauthenticateWithGoogle || canReauthenticateWithLinkedIn) && <p>If this sign-in is over ten minutes old, sign in again here, then return to set your password:</p>}
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {canReauthenticateWithGoogle && <a href="/auth/google?next=%2Faccount" className="inline-flex min-h-11 items-center text-fg underline">Sign in again with Google</a>}
                  {canReauthenticateWithLinkedIn && <a href="/auth/linkedin?intent=sign_in&next=%2Faccount" className="inline-flex min-h-11 items-center text-fg underline">Sign in again with LinkedIn</a>}
                </div>
                {!canReauthenticateWithGoogle && !canReauthenticateWithLinkedIn && <p>Neither linked sign-in method is available here. <a href="/forgot-password" className="text-fg underline">Use email password reset</a> to set a password.</p>}
              </> : <p>Confirm this account's email before setting a password.</p>}
            </div>
          )}
          <label className={labelClassName}>
            <span className={labelClass}>New password</span>
            <input name="password" type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" className={`max-w-sm ${inputClass}`} />
          </label>
          <label className={labelClassName}>
            <span className={labelClass}>Confirm new password</span>
            <input name="confirm" type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" className={`max-w-sm ${inputClass}`} />
          </label>
          <p className="text-12 text-muted">Changing it signs out every other browser.</p>
        </SettingsForm>
      </Card>

      <Card title="Sign-in methods">
        <ul className="space-y-2 text-14">
          <li>Email and password: {user.passwordHash ? <Badge tone="green">set</Badge> : <Badge tone="neutral">not set</Badge>}</li>
          <li>
            Google: {providers.some(p => p.provider === "google")
              ? <Badge tone="green">linked{providers.find(p => p.provider === "google")?.email ? ` (${providers.find(p => p.provider === "google")!.email})` : ""}</Badge>
              : googleConfigured()
                ? <span className="text-muted">not linked. <a href="/auth/google?next=%2Faccount" className="text-fg underline">Link a Google account</a> (using this email). If asked, confirm your account email and sign in again with your password or another linked method, then retry here.</span>
                : <span className="text-muted">not configured on this deployment</span>}
          </li>
          <li className="space-y-2">
            <div>LinkedIn: {providers.some(p => p.provider === "linkedin")
              ? <Badge tone="green">linked</Badge>
              : linkedinConfigured()
                ? user.emailVerifiedAt
                  ? <span className="text-muted">not linked. <a href="/auth/linkedin?intent=link&next=%2Faccount" className="text-fg underline">Link LinkedIn account</a></span>
                  : <span className="text-muted">confirm your account email before linking</span>
                : <span className="text-muted">not configured on this deployment</span>}</div>
            {providers.some(p => p.provider === "linkedin")
              ? <LinkedInDisconnectControl canDisconnect={!!user.passwordHash || (googleConfigured() && providers.some(p => p.provider === "google"))} />
              : linkedinConfigured() && user.emailVerifiedAt &&
                <p className="text-12 text-muted">You’ll confirm access to this account before linking.</p>}
          </li>
        </ul>
      </Card>

      <Card title="Sessions">
        <form action={signOutEverywhere}>
          <Button type="submit" size="sm">Sign out everywhere else</Button>
        </form>
      </Card>

    </div>
  );
}
