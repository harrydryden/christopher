import Link from "next/link";
import { accountCount, createResetLink, deleteUser, listAccounts, resetAccountAiSpend, setAccountAiBudget, setUserRole } from "@/app/actions/account";
import { saveRegistrationSettings } from "@/app/actions/settings";
import { ResetLinkButton } from "@/components/ResetLinkButton";
import { RunScheduledWork } from "@/components/RunScheduledWork";
import { adminEmails } from "@/lib/accounts";
import { isPlaceholderEmail } from "@ava/db";
import { MAX_ACCOUNT_AI_BUDGET_USD } from "@ava/core";
import { getSystemSettings } from "@/lib/settings";
import { accountAiBudgets, defaultAccountAiBudget } from "@/lib/queries/accounts";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";
import { inputClass } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { Pagination, pageNumber } from "@/components/Pagination";
import { SettingsForm } from "@/components/SettingsForm";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { requireAdmin } from "@/lib/auth";
import { formatUsd, relativeTime, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Every row carries several forms, so a page of a thousand accounts would be megabytes. */
const ACCOUNTS_PER_PAGE = 50;

export default async function AdminAccountsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const admin = await requireAdmin();
  const now = new Date();
  const [total, system, params] = await Promise.all([accountCount(), getSystemSettings(), searchParams]);
  const pages = Math.max(1, Math.ceil(total / ACCOUNTS_PER_PAGE));
  const page = Math.min(pageNumber(params.page), pages);
  // One page of accounts from the database, then one statement for that page's budgets.
  const shown = await listAccounts(page, ACCOUNTS_PER_PAGE);
  const budgets = await accountAiBudgets(shown.map((account) => account.id), now);

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

      <Card title="Scheduled work">
        <p className="mb-3 text-14 text-muted">
          The daily run and the weekly jobs start on schedule. Run the scheduler now to queue anything that is due. On a deployment without a worker service (<code>AVA_SERVERLESS_FALLBACK=1</code>) it also works through the queue for up to a minute; beside a worker that is running, it does nothing.
        </p>
        <RunScheduledWork />
      </Card>

      <Card title="Accounts">
        <p className="mb-3 text-14 text-muted">
          Everyone with an account. Each has its own monthly AI budget, the only budget there is: it resets on the 1st, its holder sets it on Settings and you can set it for anyone here. <Link prefetch={false} href="/admin/health" className="text-fg underline">Operations</Link> shows what the spend bought. Deleting an account removes everything it owns; shared companies and postings stay. A reset link lets you onboard or unblock someone when email delivery is not set up: it works once, for an hour, and confirms their address.
        </p>
        {pages > 1 && <Pagination page={page} total={total} size={ACCOUNTS_PER_PAGE} path="/admin" label="Account pages" />}
        <Table>
          <THead>
            <tr>
              <TH>Email</TH>
              <TH>Role</TH>
              <TH>Created</TH>
              <TH>Last sign-in</TH>
              <TH title="Ready builds on file">CVs produced</TH>
              <TH title="Company job boards this account follows">Companies</TH>
              <TH>AI budget</TH>
              <TH />
            </tr>
          </THead>
          <TBody>
            {shown.map((account) => {
              const budget = budgets.get(account.id) ?? defaultAccountAiBudget(now);
              return (
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
                <TD>{account.cvsProduced}</TD>
                <TD>{account.companies}</TD>
                <TD>
                  <span className="whitespace-nowrap text-fg">{formatUsd(budget.spentUsd)} of {formatUsd(budget.limitUsd)} this month</span>
                  {budget.countingSince && <span className="block text-12 text-muted">counting since {shortDate(budget.countingSince)}</span>}
                  <div className="mt-1.5 flex flex-wrap items-end gap-1.5">
                    <form action={setAccountAiBudget.bind(null, account.id)} className="flex items-end gap-1.5">
                      <label htmlFor={`aiBudgetUsd-${account.id}`} className="sr-only">Monthly AI budget for {account.email}, in dollars</label>
                      <div className="w-24">
                        <input id={`aiBudgetUsd-${account.id}`} name="aiBudgetUsd" type="number" min={0} max={MAX_ACCOUNT_AI_BUDGET_USD} step={1} defaultValue={budget.limitUsd} className={inputClass} />
                      </div>
                      <Button type="submit" size="sm">Set</Button>
                    </form>
                    <form action={resetAccountAiSpend.bind(null, account.id)}>
                      <ConfirmSubmitButton variant="secondary" confirmMessage={`Start ${account.email}'s budget month again from now? Spend up to now stops counting against the budget; nothing is deleted.`}>Reset spend</ConfirmSubmitButton>
                    </form>
                  </div>
                </TD>
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
              );
            })}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}
