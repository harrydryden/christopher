import { changePassword, deleteUser, listAccounts, resendVerification, setUserRole, signOutEverywhere, updateProfile } from "@/app/actions/account";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";
import { inputClass, labelClass } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { SettingsForm } from "@/components/SettingsForm";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { linkedProviders } from "@/lib/accounts";
import { getCurrentUser } from "@/lib/auth";
import { emailConfigured } from "@/lib/email";
import { googleConfigured } from "@/lib/google";
import { relativeTime } from "@/lib/format";
import { MIN_PASSWORD_LENGTH } from "@christopher/core";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

const NOTICES: Record<string, string> = {
  reset: "Your password has been reset and every other browser has been signed out.",
  "verify:done": "Your email address is confirmed.",
  "verify:invalid": "That confirmation link is no longer valid. Send a new one below.",
};

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ reset?: string; verify?: string }> }) {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const { user } = current;
  const sp = await searchParams;
  const notice = sp.reset ? NOTICES.reset : sp.verify ? NOTICES[`verify:${sp.verify}`] : null;
  const providers = await linkedProviders(user.id);
  const accounts = user.role === "admin" ? await listAccounts() : [];
  const now = new Date();
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
        <Card title="Accounts (administrator)">
          <p className="mb-3 text-14 text-muted">Everyone with an account. Administrators manage the shared schedule, models, budget and company catalogue. Deleting an account removes everything it owns; shared companies and postings stay.</p>
          <Table>
            <THead>
              <tr>
                <TH>Email</TH>
                <TH>Role</TH>
                <TH>Created</TH>
                <TH>Last sign-in</TH>
                <TH>Sessions</TH>
                <TH />
              </tr>
            </THead>
            <TBody>
              {accounts.map((account) => (
                <TR key={account.id}>
                  <TD>
                    <span className="text-fg">{account.email}</span>
                    {account.name && <span className="block text-12 text-muted">{account.name}</span>}
                    {!account.claimedAt && <span className="block text-12 text-warn">Migrated owner data, not yet claimed</span>}
                    {account.claimedAt && !account.emailVerifiedAt && <span className="block text-12 text-muted">email unverified</span>}
                  </TD>
                  <TD><Badge tone={account.role === "admin" ? "blue" : "neutral"}>{account.role}</Badge></TD>
                  <TD className="whitespace-nowrap">{relativeTime(account.createdAt, now)}</TD>
                  <TD className="whitespace-nowrap">{account.lastLoginAt ? relativeTime(account.lastLoginAt, now) : "never"}</TD>
                  <TD>{account.sessions}</TD>
                  <TD>
                    {account.claimedAt && (
                      <div className="flex flex-wrap gap-2">
                        <form action={setUserRole.bind(null, account.id, account.role === "admin" ? "member" : "admin")}>
                          <Button type="submit" size="sm">{account.role === "admin" ? "Make member" : "Make admin"}</Button>
                        </form>
                        {account.id !== user.id && (
                          <form action={deleteUser.bind(null, account.id)}>
                            <ConfirmSubmitButton variant="danger" confirmMessage={`Delete ${account.email} and everything it owns? This cannot be undone.`}>Delete</ConfirmSubmitButton>
                          </form>
                        )}
                      </div>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
