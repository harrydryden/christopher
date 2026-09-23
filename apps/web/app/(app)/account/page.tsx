import { changePassword, resendVerification, signOutEverywhere, updateProfile } from "@/app/actions/account";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { inputClass, labelClass } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { SettingsForm } from "@/components/SettingsForm";
import { linkedProviders } from "@/lib/accounts";
import { getCurrentUser, needsEmailConfirmation } from "@/lib/auth";
import { emailConfigured } from "@/lib/email";
import { googleConfigured } from "@/lib/google";
import { MIN_PASSWORD_LENGTH } from "@ava/core";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

const NOTICES: Record<string, string> = {
  reset: "Your password has been reset and every other browser has been signed out.",
  "verify:done": "Your email address is confirmed.",
  "verify:invalid": "That confirmation link is no longer valid. Send a new one below.",
  "verify:required": "Confirm your email address before adding companies, running discovery or building CVs. The link asks for your password.",
};

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ reset?: string; verify?: string }> }) {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const { user } = current;
  const sp = await searchParams;
  // `?verify=required` outlives the redirect that set it, so the notice it names is shown only
  // while that account really is held back.
  const key = sp.reset ? "reset" : sp.verify ? `verify:${sp.verify}` : null;
  const notice = key && (key !== "verify:required" || needsEmailConfirmation(user)) ? NOTICES[key] : null;
  const providers = await linkedProviders(user.id);
  const labelClassName = "flex flex-col gap-1.5 text-14";

  return (
    <div className="space-y-6">
      <PageHeader title="Account" description={user.email} />
      {notice && <p role="status" className="border-2 border-ok px-3 py-2 text-14 text-ok">{notice}</p>}

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
        {!user.emailVerifiedAt && (
          <form action={resendVerification} className="mt-3 flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm">Send confirmation email</Button>
            <span className="text-12 text-muted">
              {needsEmailConfirmation(user)
                ? "The link asks for your password."
                : "Nothing is blocked while this is unconfirmed; confirming just proves the address. The link asks for your password."}
            </span>
            {!emailConfigured() && <span className="text-12 text-warn">Email delivery is not configured on this deployment; the link only reaches the server log.</span>}
          </form>
        )}
      </Card>

      <Card title={user.passwordHash ? "Change password" : "Set a password"}>
        <SettingsForm action={changePassword} submitLabel={user.passwordHash ? "Change password" : "Set password"}>
          {user.passwordHash ? (
            <label className={labelClassName}>
              <span className={labelClass}>Current password</span>
              <input name="currentPassword" type="password" required autoComplete="current-password" className={`max-w-sm ${inputClass}`} />
            </label>
          ) : (
            <p className="text-14 text-muted">You sign in with Google. Setting a password lets you sign in with your email as well.</p>
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
                ? <span className="text-muted">not linked. <a href="/auth/google?next=%2Faccount" className="text-fg underline">Link a Google account</a> (it must use this email address).</span>
                : <span className="text-muted">not configured on this deployment</span>}
          </li>
        </ul>
      </Card>

      <Card title="Sessions">
        <p className="mb-3 text-14 text-muted">Sign out of every other browser and device. This one stays signed in.</p>
        <form action={signOutEverywhere}>
          <Button type="submit" size="sm">Sign out everywhere else</Button>
        </form>
      </Card>

      {user.role === "admin" && (
        <p className="text-14 text-muted">Your monthly AI budget is in <a href="/settings" className="text-fg underline">Settings</a>. Accounts, registration, the shared schedule, models and the company catalogue are managed in <a href="/admin" className="text-fg underline">Admin</a>.</p>
      )}
    </div>
  );
}
