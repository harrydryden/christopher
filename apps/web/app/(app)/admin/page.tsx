import { createResetLink, deleteUser, listAccounts, setUserRole } from "@/app/actions/account";
import { saveRegistrationSettings } from "@/app/actions/settings";
import { ResetLinkButton } from "@/components/ResetLinkButton";
import { adminEmails } from "@/lib/accounts";
import { isPlaceholderEmail } from "@christopher/db";
import { getSystemSettings } from "@/lib/settings";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";
import { PageHeader } from "@/components/PageHeader";
import { SettingsForm } from "@/components/SettingsForm";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { requireAdmin } from "@/lib/auth";
import { relativeTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AdminAccountsPage() {
  const admin = await requireAdmin();
  const [accounts, system] = await Promise.all([listAccounts(), getSystemSettings()]);
  const now = new Date();

  return (
    <div className="space-y-6">
      <PageHeader title="Admin" description="Shared configuration for this deployment. Only administrators see this section; everything here affects every account." />

      <Card title="Registration">
        <SettingsForm action={saveRegistrationSettings}>
          <p className="text-12 text-muted">
            Administrator addresses come from <code>ADMIN_EMAILS</code>: {adminEmails().join(", ")}. They can always create an account and become administrators once their address is confirmed. Everyone else can only sign up while registration is open, and joins as a member.
          </p>
          <label className="flex items-center gap-2 text-14">
            <input type="checkbox" name="registrationOpen" value="1" defaultChecked={system.registrationOpen} className="h-4 w-4" />
            Open registration to anyone who has this deployment&apos;s address
          </label>
        </SettingsForm>
      </Card>

      <Card title="Accounts">
        <p className="mb-3 text-14 text-muted">
          Everyone with an account. Deleting one removes everything it owns; shared companies and postings stay. A reset link lets you onboard or unblock someone when email delivery is not set up: it works once, for an hour, and confirms their address.
        </p>
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
                  {!account.claimedAt && <span className="block text-12 text-warn">{isPlaceholderEmail(account.email) ? "Migrated owner data, not yet claimed" : "Awaiting email confirmation"}</span>}
                  {account.claimedAt && !account.emailVerifiedAt && <span className="block text-12 text-muted">email unverified</span>}
                </TD>
                <TD><Badge tone={account.role === "admin" ? "blue" : "neutral"}>{account.role}</Badge></TD>
                <TD className="whitespace-nowrap">{relativeTime(account.createdAt, now)}</TD>
                <TD className="whitespace-nowrap">{account.lastLoginAt ? relativeTime(account.lastLoginAt, now) : "never"}</TD>
                <TD>{account.sessions}</TD>
                <TD>
                  {!isPlaceholderEmail(account.email) && (
                    <div className="flex flex-wrap gap-2">
                      {account.claimedAt && (
                        <form action={setUserRole.bind(null, account.id, account.role === "admin" ? "member" : "admin")}>
                          <Button type="submit" size="sm">{account.role === "admin" ? "Make member" : "Make admin"}</Button>
                        </form>
                      )}
                      {account.id !== admin.id && <ResetLinkButton userId={account.id} action={createResetLink} />}
                      {account.id !== admin.id && (
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
    </div>
  );
}
